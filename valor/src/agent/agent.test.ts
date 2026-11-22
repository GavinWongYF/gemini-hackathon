import { describe, expect, it } from "vitest";
import { holds, mulberry32, pick, type BehaviourJson } from "./protocol";
import { baselineBrain, DECISIONS } from "./brain";
import { makeAdaptiveBrain } from "./adaptiveBrain";
import { BASELINE_AGENT_SETTINGS, COVER_SPOTS, baselineBehaviour, valorSetup } from "./setup";
import { checkCover, chooseCandidate, mergeSettings, validateStructure } from "./selfcheck";
import { HabitTracker, OfflineStandin, STANDIN_VALUES } from "./standin";
import { PLAYERS, simulateRound } from "./sim";
import { runPracticeMatch } from "./practice";

const beh = (npc: BehaviourJson["npcs"][string]): BehaviourJson => ({ version: 1, npcs: { red: npc } });

describe("pick() — contract semantics", () => {
  const b = beh({
    decisions: { position: { hold_mid: { base: 0.5 }, watch_left_flank: { base: 0.1, when: { flanks_left: 2 } }, push_forward: { base: 0 } } },
    rules: [{ if: [{ fact: "enemy_index", is: 0 }], do: { position: "watch_left_flank" }, why: "r" }],
  });
  it("first matching legal rule decides", () => {
    const r = pick("red", "position", ["hold_mid", "watch_left_flank"], b, {}, { enemy_index: 0 });
    expect(r).toMatchObject({ choice: "watch_left_flank", byRule: true, ruleWhy: "r" });
  });
  it("a rule whose option is not legal is skipped", () => {
    expect(pick("red", "position", ["hold_mid"], b, {}, { enemy_index: 0 }).byRule).toBe(false);
  });
  it("scores = base + Σ weight×value, clamped ≥ 0, proportional draw", () => {
    const r = pick("red", "position", ["hold_mid", "watch_left_flank", "push_forward"], b, { flanks_left: 0.5 }, { enemy_index: 1 }, () => 0);
    expect(r.scores).toEqual({ hold_mid: 0.5, watch_left_flank: 1.1, push_forward: 0 });
    expect(r.choice).toBe("hold_mid"); // r=0 → first positive weight
    expect(pick("red", "position", ["hold_mid", "watch_left_flank", "push_forward"], b, { flanks_left: 0.5 }, { enemy_index: 1 }, () => 0.99).choice).toBe("watch_left_flank");
    const rng = mulberry32(7);
    let left = 0;
    for (let i = 0; i < 4000; i++) if (pick("red", "position", ["hold_mid", "watch_left_flank"], b, { flanks_left: 0.5 }, { enemy_index: 2 }, rng).choice === "watch_left_flank") left++;
    expect(left / 4000).toBeGreaterThan(0.64); // 1.1 / 1.6 = 0.6875
    expect(left / 4000).toBeLessThan(0.73);
  });
  it("all-zero scores → uniform; unknown npc → uniform", () => {
    expect(pick("red", "position", ["push_forward"], b, {}, { enemy_index: 1 }).choice).toBe("push_forward");
    expect(pick("blue", "position", ["a", "b"], b, {}, {}, () => 0.6).choice).toBe("b");
  });
  it("holds(): is / in / above / below, missing values count as 0", () => {
    expect(holds({ value: "x", below: 0.1 }, {}, {})).toBe(true);
    expect(holds({ fact: "player_zone", in: ["left", "mid"] }, {}, { player_zone: "mid" })).toBe(true);
    expect(holds({ fact: "round", above: 2 }, {}, { round: 3 })).toBe(true);
    expect(holds({ fact: "nope", above: 2 }, {}, {})).toBe(false);
  });
  it("baseline JSON makes exactly the baselineBrain choices", () => {
    const a = makeAdaptiveBrain({ behaviour: baselineBehaviour(), settings: BASELINE_AGENT_SETTINGS });
    const f = { round: 1, enemy_index: 0, player_zone: "unknown" as const, player_in_open: true, allies_alive: 3, opponents_alive: 3 };
    for (const d of Object.keys(DECISIONS) as Array<keyof typeof DECISIONS>) expect(a.decide(d, DECISIONS[d], f).choice).toBe(baselineBrain.decide(d, DECISIONS[d], f).choice);
  });
});

describe("self-check validator", () => {
  const setup = valorSetup({ matchId: "t" });
  const known = Object.keys(STANDIN_VALUES);
  const ok = (u: object) => validateStructure(u as never, setup, known, BASELINE_AGENT_SETTINGS).reasons;
  it("accepts the baseline and every single allowed non-blocking spot", () => {
    expect(ok({ behaviour: baselineBehaviour() })).toEqual([]);
    for (const s of COVER_SPOTS.filter((c) => c.kind !== "wall")) expect(checkCover([s.name])).toEqual([]);
  });
  it("rejects invented options, facts, values and too many rules", () => {
    const b = baselineBehaviour();
    b.npcs.red.decisions.position.snipe = { base: 1 };
    b.npcs.red.decisions.position.hold_mid.when = { reads_minds: 1 };
    b.npcs.red.rules = [{ if: [{ fact: "player_health", below: 3 }], do: { style: "dance" } }, ...Array(4).fill({ if: [], do: { position: "hold_mid" } })];
    const r = ok({ behaviour: b }).join("\n");
    expect(r).toMatch(/unknown option "red.position.snipe"/);
    expect(r).toMatch(/unknown value "reads_minds"/);
    expect(r).toMatch(/unknown fact "player_health"/);
    expect(r).toMatch(/unknown option "style = dance"/);
    expect(r).toMatch(/5 rules/);
  });
  it("rejects out-of-bounds settings, unknown/too much cover and lane-blocking walls", () => {
    expect(ok({ behaviour: baselineBehaviour(), settings: { enemy_accuracy: 0.95 } }).join()).toMatch(/outside 0.15–0.7/);
    expect(ok({ behaviour: baselineBehaviour(), settings: { cover: ["spawn_crate"] } }).join()).toMatch(/not one of the allowed spots/);
    expect(checkCover(["mid_wall_front"]).join()).toMatch(/block the mid lane/);
    expect(checkCover(["left_crate_mid", "left_wall_mid"]).join()).toMatch(/block the left lane/);
    expect(checkCover(COVER_SPOTS.slice(0, 5).map((c) => c.name)).join()).toMatch(/at most 4/);
    expect(mergeSettings(BASELINE_AGENT_SETTINGS, { cover: "none" }).settings.cover).toEqual([]);
  });
  it("fairness: refuses a counter that over-shoots the 35–65% band", () => {
    const over = baselineBehaviour();
    over.npcs.red.decisions.position = { hold_mid: { base: 0 }, watch_left_flank: { base: 1 }, watch_right_flank: { base: 0 }, push_forward: { base: 0 }, hold_cover: { base: 0 } };
    const res = chooseCandidate([{ label: "everything left + cover + max skill", update: { version: 2, source: "quick", behaviour: over, settings: { enemy_accuracy: 0.7, enemy_reaction_sec: 0.4, enemy_damage: 20 } } }], {
      setup,
      knownValues: known,
      current: { behaviour: baselineBehaviour(), settings: BASELINE_AGENT_SETTINGS },
      habit: { left: 3, mid: 0, right: 0, cover: 1, rush: 0 },
      round: 3,
      n: 60,
    });
    expect(res.log[0].accepted).toBe(false);
    expect(res.log[0].reasons[0]).toMatch(/band|worse/);
  });
});

describe("offline stand-in analyser", () => {
  const ev = (name: string, data: Record<string, string | number>, t: number, by = "player") => ({ type: "event" as const, match_id: "m", name, round: 1, t, by, data });
  const playRound = (s: OfflineStandin, r: number, lane: "left" | "mid", won: boolean, openDeath: boolean) => {
    s.onEvent(ev("round_start", { enemy_index: 0 }, r * 100, "red"), r);
    if (lane !== "mid") s.onEvent(ev("player_lane_change", { lane, from: "mid" }, r * 100 + 1), r);
    if (openDeath) s.onEvent(ev("died_in_open", { lane, nearest_cover_m: 4 }, r * 100 + 20), r);
    return s.onRoundEnd({ type: "round_end", match_id: "m", round: r, t: r * 100 + 30, winner: won ? "player" : "red", how: lane, score: {}, break: true });
  };
  it("counts lanes and open deaths into values", () => {
    const t = new HabitTracker();
    t.onEvent({ name: "player_lane_change", by: "player", t: 1, data: { lane: "left" } });
    t.onRoundEnd({ round: 1, winner: "player", t: 30 });
    expect(t.values()).toMatchObject({ flanks_left: 1, wins_via_left: 1, dies_in_open: 0, hugs_cover: 0 });
  });
  it("no update after one round; watch_left_flank after 2 wins via the left", () => {
    const s = new OfflineStandin("m", BASELINE_AGENT_SETTINGS);
    expect(playRound(s, 1, "left", true, false)).toEqual([]);
    const c = playRound(s, 2, "left", true, false);
    expect(c.length).toBe(3);
    expect(c.map((x) => x.update.behaviour.npcs.red.rules[0].do.position)).toEqual(["watch_left_flank", "watch_left_flank", "watch_left_flank"]);
    expect(c[2].update.behaviour.npcs.red.rules[0].if[0]).toEqual({ fact: "enemy_index", in: [0] });
    expect(c[0].update.type).toBe("strategy_update");
    expect(c[0].update.observations[0]).toMatch(/Won 2 of the last 2 rounds by going up the left/);
  });
  it("adds cover in the lane where the player keeps dying in the open", () => {
    const s = new OfflineStandin("m", BASELINE_AGENT_SETTINGS);
    playRound(s, 1, "mid", false, true);
    const c = playRound(s, 2, "mid", false, true);
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) expect(x.settings.cover.every((n) => n.startsWith("mid_"))).toBe(true);
  });
});

describe("headless sim", () => {
  it("is deterministic for a seed and goes through Brain.decide", () => {
    const a = simulateRound({ brain: baselineBrain, player: PLAYERS.mixed_random, round: 1, rng: mulberry32(3) });
    const b = simulateRound({ brain: baselineBrain, player: PLAYERS.mixed_random, round: 1, rng: mulberry32(3) });
    expect(a).toEqual(b);
    expect(a.redPositions).toEqual(["hold_mid", "hold_mid", "hold_mid"]);
  });
  it("round 1 is identical for baseline and adaptive arms (common random numbers)", () => {
    const x = runPracticeMatch({ player: PLAYERS.flank_left_always, seed: 5, mode: "baseline", rounds: 1 });
    const y = runPracticeMatch({ player: PLAYERS.flank_left_always, seed: 5, mode: "standin", rounds: 1 });
    expect(y.rounds[0].winner).toBe(x.rounds[0].winner);
    expect(y.rounds[0].seconds).toBe(x.rounds[0].seconds);
  });
});
