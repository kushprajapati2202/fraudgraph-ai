import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "system" | "light" | "dark";

interface Prefs {
  analystName: string;
  theme: Theme;
  setAnalystName: (name: string) => void;
  setTheme: (theme: Theme) => void;
  /** Effective theme after resolving "system". */
  resolvedTheme: "light" | "dark";
}

const NAME_KEY = "fraudgraph.analystName";
const THEME_KEY = "fraudgraph.theme";
const DEFAULT_NAME = "Analyst";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference lasts for this page only */
  }
}

const systemDark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

const PrefsContext = createContext<Prefs>({
  analystName: DEFAULT_NAME,
  theme: "system",
  setAnalystName: () => undefined,
  setTheme: () => undefined,
  resolvedTheme: "light",
});

export const usePrefs = () => useContext(PrefsContext);

export function initials(name: string): string {
  // Letters only: "New beneficiary 901 (simulated)" gives "NS", not "N(".
  const parts = name.trim().split(/\s+/).map((p) => p.replace(/[^\p{L}]/gu, "")).filter(Boolean);
  if (!parts.length) return name.trim()[0] ?? "A";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [analystName, setName] = useState(() => read(NAME_KEY) || DEFAULT_NAME);
  const [theme, setThemeState] = useState<Theme>(() => {
    // ?theme=light|dark overrides the saved choice for this visit (used for screenshots and shared links).
    const t = new URLSearchParams(window.location.search).get("theme") || read(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  });
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return undefined;
    const onChange = () => setSysDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "light" | "dark" = theme === "system" ? (sysDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  const setAnalystName = useCallback((name: string) => {
    const clean = name.replace(/[^A-Za-z0-9 _.\-]/g, "").slice(0, 60);
    setName(clean || DEFAULT_NAME);
    write(NAME_KEY, clean || DEFAULT_NAME);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    write(THEME_KEY, t);
  }, []);

  return <PrefsContext.Provider value={{ analystName, theme, setAnalystName, setTheme, resolvedTheme }}>{children}</PrefsContext.Provider>;
}
