import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api/client";

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function fmtAmount(amount: number, currency: string | null = "INR"): string {
  return `${currency === "INR" ? "₹" : (currency ?? "") + " "}${inr.format(amount)}`;
}

export function fmtShortAmount(amount: number): string {
  if (amount >= 10_000_000) return `${(amount / 10_000_000).toFixed(1)}Cr`;
  if (amount >= 100_000) return `${(amount / 100_000).toFixed(1)}L`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}k`;
  return String(Math.round(amount));
}

/** Compact Indian-system amount for tiles and charts, e.g. 12.4 L, 3.1 Cr. */
export function fmtCompact(amount: number): string {
  return `₹${fmtShortAmount(amount)}`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** "Rapid onward movement from AC-156 - 8 accounts, 7 transfers" -> "Rapid onward movement". */
export function caseHeadline(title: string): string {
  return title.split(" - ")[0].split(" from ")[0];
}

export function fmtDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function fmtDuration(startTs: string | null, endTs: string | null): string {
  if (!startTs || !endTs) return "unknown";
  const mins = Math.round((new Date(endTs).getTime() - new Date(startTs).getTime()) / 60000);
  if (mins < 1) return "under 1 min";
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `${Math.round(mins / 1440)} days`;
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "unknown";
  return ts.replace("T", " ").slice(0, 16);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Runs `fn` whenever `deps` change; ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (id === seq.current) setData(d);
      })
      .catch((e) => {
        if (id === seq.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Sets the browser tab title for the current page. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · FraudGraph AI` : "FraudGraph AI";
  }, [title]);
}

export function readCssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
