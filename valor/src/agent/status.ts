// SHARED CONTRACT: what the HUD shows about the adaptive agent system.
// Written by the agent bridge (src/agent/*), read by the HUD (src/game/HUD*).

import { create } from "zustand";

export type AgentMode = "baseline" | "offline_standin" | "live_gemini";

export interface StrategyChange {
  where: string; // e.g. "red.position.watch_left_flank" or "settings.cover"
  from: unknown;
  to: unknown;
  why: string;
}

export interface AgentStatus {
  mode: AgentMode;
  connected: boolean; // WebSocket to ws://localhost:8000/ws is open
  version: number; // behaviour version currently applied
  source: "quick" | "full" | null;
  observations: string[]; // 2-4 lines: what the agents noticed about the player
  plan: string[]; // 2-4 lines: what the enemies will do differently
  changes: StrategyChange[];
  /** Agent output the game's self-check refused (and why) — shown honestly. */
  rejected: string[];
  set(partial: Partial<Omit<AgentStatus, "set">>): void;
}

export const useAgentStatus = create<AgentStatus>((set) => ({
  mode: "baseline",
  connected: false,
  version: 0,
  source: null,
  observations: [],
  plan: [],
  changes: [],
  rejected: [],
  set: (partial) => set(partial),
}));
