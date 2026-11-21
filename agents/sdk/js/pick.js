// How an NPC picks, on the game side.
//
// Call `pick` at the one place in your game where an NPC chooses what to do.
// It only reads what the game already holds, so it never waits on the network.
// It behaves exactly like sdk/python/adaptive_npc/pick.py. Both are checked
// against sdk/test-vectors.json.

const has = (obj, key) => obj != null && Object.hasOwn(obj, key);

// Python treats None, an empty object and an empty list as false. This does the same.
const isEmpty = (x) =>
  x == null || x === false || (typeof x === "object" && Object.keys(x).length === 0);

const get = (obj, key, fallback) => (has(obj, key) ? obj[key] : fallback);

function same(a, b) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function oneOf(x, list) {
  if (typeof list === "string") return typeof x === "string" && list.includes(x);
  return Array.isArray(list) && list.some((item) => same(item, x));
}

function choose(legal, rng) {
  return legal[Math.min(Math.floor(rng() * legal.length), legal.length - 1)];
}

/**
 * Return [option, byRule]: the option to play, and whether a rule decided it.
 *
 * npc, decision: the names your `setup` gave them
 * legal:         the options allowed right now
 * behaviour:     the latest behaviour you received
 * values:        the latest `player_read` values, each 0 to 1
 * facts:         what the NPC can see right now, by the names in `setup`
 * rng:           optional, a function that returns a number from 0 up to 1
 */
export function pick(npc, decision, legal, behaviour, values = {}, facts = {}, rng = Math.random) {
  values = values || {};
  facts = facts || {};
  const mine = get(get(behaviour, "npcs", {}), npc, undefined);
  if (isEmpty(mine) || !legal || legal.length === 0) {
    return [legal && legal.length ? choose(legal, rng) : "", false];
  }

  // 1. Rules first. The first rule that fits and is legal decides.
  for (const rule of get(mine, "rules", []) || []) {
    const choice = get(get(rule, "do", {}), decision, undefined);
    const conditions = get(rule, "if", []) || [];
    if (choice !== undefined && legal.includes(choice) && conditions.every((c) => holds(c, values, facts))) {
      return [choice, true];
    }
  }

  // 2. Otherwise score every legal option, then pick in proportion to the scores.
  const options = get(get(mine, "decisions", {}), decision, {}) || {};
  const scores = legal.map((name) => {
    const option = get(options, name, {}) || {};
    let score = get(option, "base", 0);
    for (const [valueName, weight] of Object.entries(get(option, "when", {}) || {})) {
      score += weight * get(values, valueName, 0);
    }
    return Math.max(score, 0);
  });
  const total = scores.reduce((a, b) => a + b, 0);
  if (total === 0) return [choose(legal, rng), false];

  // The same walk as Python's random.choices: the first running total above the draw.
  const draw = rng() * total;
  let running = 0;
  for (let i = 0; i < legal.length; i++) {
    running += scores[i];
    if (running > draw) return [legal[i], false];
  }
  return [legal[legal.length - 1], false];
}

/** Whether one condition of a rule is true right now. */
export function holds(cond, values = {}, facts = {}) {
  let x = has(cond, "value") ? get(values, cond.value, 0) : get(facts, cond.fact, null);
  if (x === undefined) x = null;
  if (has(cond, "is")) return same(x, cond.is);
  if (has(cond, "in")) return oneOf(x, cond.in);
  if (x === null) return false;
  if (has(cond, "above")) return x > cond.above;
  if (has(cond, "below")) return x < cond.below;
  return false;
}
