// ─────────────────────────────────────────────────────────────────────────
// combat.ts — the LOCAL authoritative damage sink (PASS 1).
//
// This is the local stand-in for the future SpacetimeDB `fire()` reducer. It is
// the SOLE owner of health subtraction, death, and respawn. Weapon code never
// decrements health itself — it calls `combat.applyDamage(...)`, exactly the
// shape that becomes a reducer call in PASS 2 (the `CombatSink` interface is the
// swap point, so the transport changes but call sites don't).
//
// Damage model is LOCKED in contracts.ts: 20 dmg/shot, 100 HP, 5 shots to kill.
// The pure arithmetic is `computeDamage` (unit-tested headlessly in
// combat.test.ts — no renderer needed); `applyDamage` wires it to the store and
// emits hit/kill events for the HUD.
// ─────────────────────────────────────────────────────────────────────────

import { type CombatSink, type DamageEvent, LOCAL_ID, MAX_HEALTH, RESPAWN_MS, type Vec3 } from "./contracts";
import { useMatch } from "./match";
import { transforms, useGame } from "./stores";
import { playHurt, playSfx } from "./sfx";
import { emitKill } from "./teamAI";

/** Match rules. RoundManager turns `respawn` off (no respawn inside a round).
 *  friendlyFire OFF: same-team damage (player→ally, ally→player, red→red) is
 *  ignored; dead shooters can't deal damage either. */
export const combatRules = { friendlyFire: false, respawn: true };

/** Pure, side-effect-free damage resolution — the deterministic core. */
/** Last damage the LOCAL player took (HUD directional indicator + death msg).
 *  `from` = attacker position at the moment of the hit. */
export const lastPlayerDamage = { byId: "", from: [0, 0, 0] as Vec3, t: 0, seq: 0 };

export function computeDamage(health: number, amount: number): { health: number; dead: boolean } {
  const next = Math.max(0, health - amount);
  return { health: next, dead: next <= 0 };
}

export const combat: CombatSink = {
  applyDamage({ targetId, amount, byId }: DamageEvent) {
    const g = useGame.getState();
    const target = g.entities[targetId];
    if (!target || !target.alive) return; // can't damage the missing or the dead
    const attacker = byId ? g.entities[byId] : undefined;
    if (attacker && byId !== targetId) {
      if (!attacker.alive) return; // the dead don't shoot
      if (!combatRules.friendlyFire && attacker.team === target.team) return;
      // Damage (bots AND the player) only counts while the round is LIVE —
      // never in warmup / intro / round end / match end.
      if (useMatch.getState().phase !== "live") return;
    }

    const { health, dead } = computeDamage(target.health, amount);
    const t = Date.now();
    if (targetId === LOCAL_ID && byId && byId !== LOCAL_ID) {
      const ap = transforms[byId]?.pos;
      if (ap) lastPlayerDamage.from = [ap[0], ap[1], ap[2]];
      // Hurt cue, panned toward the shooter, so a hit from off-screen is heard
      // from the side it came from (not "from nowhere").
      const me = transforms[LOCAL_ID];
      let pan = 0;
      if (ap && me) {
        const dx = ap[0] - me.pos[0];
        const dz = ap[2] - me.pos[2];
        const len = Math.hypot(dx, dz) || 1;
        // Camera right vector for yaw (yaw=0 faces -Z): (cos y, 0, -sin y).
        pan = (dx * Math.cos(me.yaw) - dz * Math.sin(me.yaw)) / len;
      }
      if (!dead) playHurt(pan);
      lastPlayerDamage.byId = byId;
      lastPlayerDamage.t = t;
      lastPlayerDamage.seq++;
    }
    // Sounds are only for what concerns the LOCAL player: their own hitmarker,
    // and the kill scream when they kill or die. Bot-vs-bot hits are silent
    // (they used to play the hitmarker, which sounded like being hit).
    const involvesLocal = byId === LOCAL_ID || targetId === LOCAL_ID;
    if (dead) {
      g.patch(targetId, { health: 0, alive: false, fireState: "ready", reloading: false, respawnAt: combatRules.respawn ? t + RESPAWN_MS : undefined });
      g.pushEvent({ kind: "kill", by: byId, on: targetId, t });
      emitKill(byId, targetId);
      if (involvesLocal) playSfx("scream"); // Wilhelm scream on a kill
    } else {
      g.patch(targetId, { health });
      g.pushEvent({ kind: "hit", by: byId, on: targetId, t });
      if (byId === LOCAL_ID) playSfx("hit"); // hitmarker on the player's own hit
    }
  },
};

/** Per-frame respawn check — call once from GameScene's useFrame. Revives any
 *  entity whose respawn timer has elapsed at full health. */
export function tickCombat(now: number) {
  const g = useGame.getState();
  for (const e of Object.values(g.entities)) {
    if (!e.alive && e.respawnAt != null && now >= e.respawnAt) {
      g.patch(e.id, { alive: true, health: MAX_HEALTH, respawnAt: undefined });
    }
  }
}
