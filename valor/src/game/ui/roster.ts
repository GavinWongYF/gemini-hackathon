// Who is on which team, what to call them, and their kills/deaths this match.
//
// Bot ids ("bot1", "ally2", …) become short callsigns so the killfeed and
// scoreboard read like a real match. The kill tally is accumulated here from
// the game's event ring (which only keeps the last few events), and cleared
// when the match goes back to warmup.

import { create } from "zustand";
import { LOCAL_ID, type Entity, type GameEvent } from "../contracts";
import { useGame } from "../stores";
import { useMatch, type Team } from "../match";

const CALLSIGNS: Record<Team, string[]> = {
  blue: ["ATLAS", "EMBER", "KITE", "BRAVO"],
  red: ["WRAITH", "HEX", "TALON", "ONYX", "SPECTRE"],
};

function guessTeam(id: string): Team {
  if (id === LOCAL_ID || /blue|ally|friend/i.test(id)) return "blue";
  return "red";
}

export function teamOf(id: string, entities: Record<string, Entity>): Team {
  return entities[id]?.team ?? guessTeam(id);
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Members of a team, local player first, then bots in id order. */
export function membersOf(team: Team, entities: Record<string, Entity>): Entity[] {
  return Object.values(entities)
    .filter((e) => e.team === team)
    .sort((a, b) => (a.id === LOCAL_ID ? -1 : b.id === LOCAL_ID ? 1 : natural(a.id, b.id)));
}

/** "YOU" for the local player, otherwise a stable callsign per team slot. */
export function displayName(id: string, entities: Record<string, Entity>): string {
  if (id === LOCAL_ID) return "YOU";
  const team = teamOf(id, entities);
  const bots = Object.values(entities)
    .filter((e) => e.team === team && e.id !== LOCAL_ID)
    .map((e) => e.id)
    .sort(natural);
  let idx = bots.indexOf(id);
  if (idx < 0) {
    const n = /(\d+)$/.exec(id);
    idx = n ? Number(n[1]) - 1 : -1;
  }
  return CALLSIGNS[team][idx] ?? id.toUpperCase();
}

// ── kills / deaths for the TAB scoreboard ─────────────────────────────────
interface Tally {
  kills: Record<string, number>;
  deaths: Record<string, number>;
}
export const useTally = create<Tally>(() => ({ kills: {}, deaths: {} }));

const seen = new Set<string>();
const keyOf = (e: GameEvent) => `${e.kind}|${e.by}|${e.on}|${e.t}`;

function ingest(events: GameEvent[]) {
  let kills: Record<string, number> | null = null;
  let deaths: Record<string, number> | null = null;
  for (const e of events) {
    if (e.kind !== "kill") continue;
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    const cur = useTally.getState();
    kills ??= { ...cur.kills };
    deaths ??= { ...cur.deaths };
    if (e.by !== e.on) kills[e.by] = (kills[e.by] ?? 0) + 1;
    deaths[e.on] = (deaths[e.on] ?? 0) + 1;
  }
  if (kills && deaths) useTally.setState({ kills, deaths });
}

ingest(useGame.getState().events);
useGame.subscribe((s, prev) => {
  if (s.events !== prev.events) ingest(s.events);
});
useMatch.subscribe((s, prev) => {
  if (s.phase === "warmup" && prev.phase !== "warmup") {
    // Keep `seen` so old ring entries aren't counted again after a restart.
    for (const e of useGame.getState().events) seen.add(keyOf(e));
    useTally.setState({ kills: {}, deaths: {} });
  }
});
