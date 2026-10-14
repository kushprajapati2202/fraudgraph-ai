import { createContext, useContext } from "react";
import type { AiStatus, Health } from "./api/client";

export const HealthContext = createContext<Health | null>(null);
export const useHealth = () => useContext(HealthContext);

export interface AiStatusState {
  status: AiStatus | null;
  checking: boolean;
  error: string | null;
  /** Re-check Gemini. `force` bypasses the server-side cache (makes a real API call). */
  recheck: (force?: boolean) => void;
}

export const AiStatusContext = createContext<AiStatusState>({ status: null, checking: false, error: null, recheck: () => undefined });
export const useAiStatus = () => useContext(AiStatusContext);
