/* Side panels for a game's own live view.

   <npc-panel side="left">   the short loop: how this player plays right now, read by read
   <npc-panel side="right">  the longer loop: what it noticed and what it plans
   <npc-panel side="left" match="m_001">  the same, for that one match and no other

   Load it as a module from the agent server:
     <script type="module" src="http://localhost:8000/screen/panels.js" async></script>

   Both panels share one socket to /watch on the server this file came from.
   They take nothing from the page around them and draw nothing until a match
   is ready. They read the colour behind them and pick an accent that shows on it;
   a page can set --npc-accent to choose its own. When the server has more than one match going, they follow the
   one a person is playing. Styles stay inside each panel's shadow root.

   read(lines) is the whole logic: stream lines in, the words for each side out. */

const MAX_WORDS = 12;
const SLACK = 2;         /* a line this many words over is left whole */
const FLOOR = 0.25;      /* a read below this is not a habit worth a line */
const MAX_DRIVES = 1;    /* one read also says what the opponent does about it, to keep the panel light */
/* The pause screen's three dials. Change one number and reload the page. */
const PAUSE_LINES = 3;   /* lines a side, at most */
const PAUSE_SIZE = 1;    /* all of the pause screen's type. 1.15 is 15% larger */
const PAUSE_PAD = 1;     /* the space around the pause screen's text. 1.3 is 30% more */

const MAX_ROWS = 8;      /* reads listed at once, when the server says what kind each one is */
const HOLD_MS = 5000;    /* rows keep their place this long: the list is put in order at most this often */
const MOVE_MS = 150;     /* how long a bar takes to reach a new value */
const MARK_MS = 1500;    /* how long the read that changed most stays marked */
const RATE_MS = 5000;    /* reads per second are counted over this long */

/* ---------- words ---------- */

function clean(text) { return String(text == null ? "" : text).replace(/\s+/g, " ").trim(); }
function cap(text) { text = clean(text).replace(/_/g, " "); return text.charAt(0).toUpperCase() + text.slice(1); }

/* About `max` words. A line a word or two over stays whole. A longer one becomes its
   first sentence if that fits, else a whole clause, else it is cut at a word. */
function short(text, max) {
  max = max || MAX_WORDS;
  text = clean(text);
  const parts = text.split(" ");
  if (parts.length <= max + SLACK) return text;
  const first = text.match(/^(.+?[.!?])\s/);
  if (first) {
    const n = first[1].split(" ").length;
    if (n >= 3 && n <= max) return first[1];
  }
  const head = parts.slice(0, max).join(" ");
  const at = Math.max.apply(null, [", ", " and ", " but ", " so ", " because ", " which "].map((mark) => head.lastIndexOf(mark)));
  if (at > 0 && head.slice(0, at).split(" ").length >= 4) return head.slice(0, at).replace(/[,;:]+$/, "") + ".";
  return head.replace(/[,;:.]+$/, "") + "...";
}

function stop(text) { return /[.!?]$/.test(text) ? text : text + "."; }

function modelName(id) {
  return clean(id).split(/[-_]/).map((part) => cap(part)).join(" ");
}

/* "aim" -> "aims", "pass" -> "passes", "carry" -> "carries" */
function third(verb) {
  if (/(s|x|z|ch|sh)$/i.test(verb)) return verb + "es";
  if (/[^aeiou]y$/i.test(verb)) return verb.slice(0, -1) + "ies";
  return verb + "s";
}

function lower(text) { text = clean(text).replace(/_/g, " "); return text.charAt(0).toLowerCase() + text.slice(1); }

/* The behaviour in play, turned round: for each value name, the option it pulls on hardest.
   A weight under `when` means the higher this player's read, the more that option is picked. */
function pulls(behaviour) {
  const found = {};
  const npcs = (behaviour && behaviour.npcs) || {};
  Object.keys(npcs).forEach((npc) => {
    const decisions = (npcs[npc] && npcs[npc].decisions) || {};
    Object.keys(decisions).forEach((decision) => {
      const options = decisions[decision] || {};
      Object.keys(options).forEach((option) => {
        const when = options[option] && options[option].when;
        if (!when || typeof when !== "object") return;
        Object.keys(when).forEach((value) => {
          const weight = Number(when[value]);
          if (!weight) return;
          const best = found[value];
          /* a pull towards an option beats a pull away from one, then the larger weight wins */
          const wins = !best || ((weight > 0) !== (best.weight > 0) ? weight > 0 : Math.abs(weight) > Math.abs(best.weight));
          if (wins) found[value] = { npc: npc, decision: decision, option: option, weight: weight };
        });
      });
    });
  });
  return found;
}

/* One plain line for a pull, built from the names the game gave in setup. */
function pullLine(pull, setup) {
  const about = (((setup && setup.npcs) || {})[pull.npc] || {}).decisions || {};
  const entry = about[pull.decision] || {};
  const choice = (entry.options || {})[pull.option];
  const decision = lower(entry.label || pull.decision);
  const option = lower((choice && typeof choice === "object" && choice.label) || pull.option);
  const way = pull.weight > 0 ? "more" : "less";
  /* said by the opponent. "Aim" reads as a verb: "So I aim left short more." Anything else is said flat. */
  if (/^(aim|anticipate|move|pass|shoot|attack|defend)$/i.test(decision)) return "So I " + decision + " " + option + " " + way + ".";
  return "So I pick " + option + " " + way + " often.";
}

/* Model ids read as names in every line: "gemini-4-neon" becomes "Gemini 4 Neon". */
function readable(text, ids) {
  let out = String(text == null ? "" : text);
  ids.slice().sort((a, b) => b.length - a.length).forEach((id) => { out = out.split(id).join(modelName(id)); });
  return out.replace(/\b[a-z]+(?:-[a-z0-9]+)*-\d+(?:\.\d+)?(?:-[a-z0-9]+)*\b/g, (id) => modelName(id));
}

/* The reads one message lists as rows: the ones it is sure of, strongest first, then any that were
   listed before and that it is no longer sure of. Two values with one label show once. When the
   server says what kind each value is, up to 8 rows with at most 2 of a kind, and room kept for 2
   that come from the camera. With no kinds, the 3 strongest. A likeness is never a row. */
function listed(message, labels, shown, kinds, rich, fields) {
  const unsure = {};
  (Array.isArray(message.low_confidence) ? message.low_confidence : []).forEach((n) => { unsure[n] = true; });
  const values = message.values || {};
  const given = (n) => (kinds && kinds[n]) || (/^like_/.test(n) ? "likeness" : "share");
  /* the server's kinds are coarse (share, level, camera). Two of a kind goes by what a read is
     about: the shot, the side, where the ball lands, a tell, power, or what only the camera sees. */
  const about = { topspin: "shot", slice: "shot", drop: "shot", lob: "shot", flat: "shot", racket: "side", court: "placement", timing: "tell", power: "power", speed: "power" };
  const kindOf = (n) => {
    const kind = given(n);
    if (kind === "likeness" || kind === "camera") return kind;
    if (fields && fields[n]) return fields[n];   /* the game's own field: two reads on one field at most */
    return about[glyphOf({ text: (labels[n] || "") + " " + n.replace(/_/g, " ") }, "")] || kind;
  };
  const names = Object.keys(values)
    .filter((n) => typeof values[n] === "number" && given(n) !== "likeness" &&
      (rich || given(n) !== "share" || values[n] >= FLOOR) && (!unsure[n] || shown[n]))
    .sort((a, b) => (unsure[a] ? 1 : 0) - (unsure[b] ? 1 : 0) || values[b] - values[a]);
  const max = rich ? MAX_ROWS : 3;
  const kept = rich ? Math.min(2, names.filter((n) => kindOf(n) === "camera").length) : 0;
  const per = {};
  let others = 0;
  const habits = [];
  names.forEach((n) => {
    const kind = kindOf(n);
    const text = short(labels[n] || cap(n));
    const same = habits.filter((h) => h.text.toLowerCase() === text.toLowerCase())[0];
    if (same) { same.names.push(n); return; }
    if (habits.length >= max) return;
    if (rich && ((per[kind] || 0) >= 2 || (kind !== "camera" && others >= max - kept))) return;
    per[kind] = (per[kind] || 0) + 1;
    if (kind !== "camera") others += 1;
    habits.push({ name: n, names: [n], text: text, value: Math.max(0, Math.min(1, values[n])), kind: kind, field: (fields && fields[n]) || "", camera: given(n) === "camera", unsure: !!unsure[n], drives: "" });
  });
  return habits;
}

/* The share of rounds the player should end up winning: a number the setup gives, a percent its goal names, else a half. */
function targetOf(setup) {
  const s = setup || {};
  const goal = s.goal;
  const given = [s.target_share, s.target_player_share, (s.plan || {}).target_share, goal && typeof goal === "object" ? goal.target_share : null]
    .filter((v) => typeof v === "number" && v > 0 && v <= 100)[0];
  if (given != null) return given > 1 ? given / 100 : given;
  const named = typeof goal === "string" ? goal.match(/(\d{1,2})\s?(?:%|percent)/i) : null;
  return named ? Number(named[1]) / 100 : 0.5;
}

/* What the game calls one round, when its setup says. */
function roundWord(setup) {
  const s = setup || {};
  const word = s.round_label || (s.plan || {}).round_label || (s.labels || {}).round || (s.words || {}).round;
  if (typeof word === "string" && word) return lower(word);
  /* a game that talks about points in its own description plays points */
  return /\bpoints?\b/i.test(clean(s.about) + " " + (typeof s.goal === "string" ? s.goal : "")) ? "point" : "round";
}

/* The player's share of finished rounds: over the last ten after each round, and over all of them. */
function winShare(rounds, setup) {
  const counted = Object.keys(rounds).map(Number).sort((a, b) => a - b).map((n) => rounds[n]);   /* every finished round, as the scoreboard has it */
  const word = roundWord(setup);
  const win = { rounds: counted.length, won: 0, lastRounds: 0, lastWon: 0, share: 0, all: 0, series: [], target: targetOf(setup), word: word, words: word + "s" };
  counted.forEach((r, i) => {
    const part = counted.slice(Math.max(0, i - 9), i + 1);
    const won = part.filter((x) => x.winner === "player").length;
    win.series.push(won / part.length);
    win.lastRounds = part.length; win.lastWon = won;
    if (r.winner === "player") win.won += 1;
  });
  if (counted.length) { win.share = win.lastWon / win.lastRounds; win.all = win.won / counted.length; }
  return win;
}

function isSetting(change) {
  return !!change && (change.kind === "fairness" || /^settings\./.test(String(change.where || "")));
}

/* ---------- the logic: stream lines in, the words for each side out ---------- */

function read(lines, after) {
  let setup = null, ready = false, labels = {}, lastRead = null, updates = [], behaviour = null;
  let shown = {}, models = {};
  let rounds = {}, highest = 0;
  let kinds = {}, fields = {}, rich = false, reads = 0;
  let writer = { model: "", open: false, about: "" };

  (lines || []).forEach((line) => {
    const m = line && line.message ? line.message : line;
    if (!m || !m.type) return;
    if (m.type === "setup") {
      /* a game sends setup again for the match it is already in: nothing starts over */
      if (setup && m.match_id != null && m.match_id === setup.match_id) { setup = m; return; }
      setup = m; ready = false; labels = {}; lastRead = null; updates = []; shown = {};
      rounds = {}; highest = 0; kinds = {}; fields = {}; rich = false; reads = 0;
      behaviour = m.default_behaviour || null;
      writer = { model: "", open: false, about: "" };
      return;
    }
    if (setup && m.match_id && setup.match_id && m.match_id !== setup.match_id) return;

    if (m.type === "ready" || m.type === "strategy_update") {
      const values = (m.type === "ready" ? m.values : m.new_values) || {};
      Object.keys(values).forEach((name) => {
        const v = typeof values[name] === "string" ? { label: values[name] } : (values[name] || {});
        labels[name] = v.label || v.about || cap(name);
        if (v.field) fields[name] = String(v.field);
        /* the server may say what kind of read this is. An older one does not: a share, or a likeness by its name */
        kinds[name] = v.kind ? String(v.kind) : /^like_/.test(name) ? "likeness" : "share";
        if (v.kind) rich = true;
      });
    }
    if ((m.type === "event" || m.type === "round_end") && typeof m.round === "number") {
      /* round 1 again after later rounds: the game began again under the same id */
      if (m.round === 1 && highest >= 2 && rounds[1]) { rounds = {}; highest = 0; }
      if (m.type === "round_end") { rounds[m.round] = m; highest = Math.max(highest, m.round); }
    }
    if (m.type === "ready") ready = true;
    if (m.type === "ready" && typeof m.round_label === "string" && m.round_label && setup) setup = Object.assign({}, setup, { round_label: m.round_label });
    if ((m.type === "ready" || m.type === "strategy_update") && m.behaviour) behaviour = m.behaviour;
    if (m.type === "player_read") {
      if (!(typeof m.based_on_events === "number" && m.based_on_events <= 0)) {
        lastRead = m; reads += 1;
        listed(m, labels, shown, kinds, rich, fields).forEach((h) => { h.names.forEach((n) => { shown[n] = true; }); });
      } else if (lastRead) {
        /* a read made from the picture alone is a guess about habits, so it lists nothing new.
           It still moves what the camera sees, once the rows are there. */
        const values = Object.assign({}, lastRead.values);
        let any = false;
        Object.keys(m.values || {}).forEach((n) => {
          if (kinds[n] === "camera" && typeof m.values[n] === "number") { values[n] = m.values[n]; any = true; }
        });
        if (any) { lastRead = Object.assign({}, lastRead, { values: values }); reads += 1; }
      }
    }
    if (m.type === "trace" && m.model) models[m.model] = true;
    if (m.type === "strategy_update") { updates.push(m); writer.open = false; }
    if (m.type === "trace" && m.stage === "adapter") {
      if (m.model) writer.model = m.model;
      if (m.status === "start") { writer.open = true; writer.about = m.about || ""; }
      else if (m.status === "error") writer.open = false;
    }
  });

  /* left: the reads as rows, what the opponent does about them, and the best likeness */
  const left = { title: "Decisions API", id: setup ? String(setup.match_id || "") : "", habits: [], like: null, why: null,
    reads: reads, max: rich ? MAX_ROWS : 3, rate: 0 };
  if (lastRead) {
    left.habits = listed(lastRead, labels, shown, kinds, rich, fields);
    const seen = lastRead.values || {};
    const likes = Object.keys(seen).filter((n) => (kinds[n] || (/^like_/.test(n) ? "likeness" : "")) === "likeness" &&
      typeof seen[n] === "number" && seen[n] >= FLOOR).sort((a, b) => seen[b] - seen[a]);
    if (likes.length && left.habits.length) {
      left.like = { name: likes[0], text: short(labels[likes[0]] || cap(likes[0])), value: Math.min(1, seen[likes[0]]) };
    }
    const pull = pulls(behaviour);
    let said = 0;
    left.habits.forEach((h) => {
      const best = h.names.map((n) => pull[n]).filter(Boolean).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))[0];
      if (best && !h.unsure && said < MAX_DRIVES) { h.drives = pullLine(best, setup); said += 1; }
    });
    const why = clean(lastRead.why);
    if (why && left.habits.length) {
      /* the server says which read moved and which way: keep its name, show the way as an arrow */
      const moved = why.match(/^(.*?):\s*(stronger|weaker)\b/i) || why.match(/^(.*):\s*(up|down) from [\d.]+ to [\d.]+/i);
      const firstRead = why.match(/^(.*?):\s*(?:strongest|[\d.]+) on the first read/i);
      left.why = moved ? { text: stop(short(moved[1])), dir: /^(stronger|up)$/i.test(moved[2]) ? "up" : "down" }
        : { text: stop(short(firstRead ? firstRead[1] : why)), dir: "" };
    }
  }

  /* right: the latest rewrite, with any change to a setting kept apart */
  let strategy = null, fair = null, checked = null;
  updates.forEach((u) => {
    const changes = Array.isArray(u.changes) ? u.changes : [];
    if (changes.some(isSetting)) fair = u;
    if (!changes.length || changes.some((c) => !isSetting(c))) strategy = u;
    if (Array.isArray(u.checks) && u.checks.length) checked = u;
  });
  const right = {
    title: writer.model ? modelName(writer.model) : "Gemini 4 Neon",
    thinking: writer.open, about: writer.open ? short(writer.about) : "",
    noticed: [], plan: [], check: null, fairness: "",
    win: winShare(rounds, setup)
  };
  if (strategy) {
    right.noticed = (strategy.observations || []).slice(0, 2).map((t) => short(t));
    right.plan = (strategy.plan || []).slice(0, 2).map((t) => short(t));
  }
  if (checked) {
    const check = checked.checks[0];
    if (check && check.said && typeof check.held === "boolean") {
      right.check = { said: short(check.said).replace(/([^.])\.$/, "$1"), held: check.held };
    }
  }
  if (fair && (!strategy || fair.version >= strategy.version)) {
    const change = fair.changes.filter(isSetting)[0];
    const why = clean(change.why).replace(/^fairness adjustment:\s*/i, "");
    const options = [why, why.split(/,\s*so\s+/i)[1], (fair.observations || [])[0]].filter(Boolean).map((t) => cap(t));
    const fits = options.filter((t) => t.split(" ").length <= MAX_WORDS);
    right.fairness = fits.length ? fits[0] : options.length ? short(options[0]) : "";
  }

  /* The pause screen explains the last real update: one with something in `changes`. A holding
     update never takes its place. Left, what was seen of the player. Right, what changes: the
     shot change first, and a speed step after it with its reason. `after` is the version that was
     current when the last pause ended, so a pause explains what came since. */
  const changesOf = (u) => (Array.isArray(u.changes) ? u.changes : []);
  const pick = (pool) => {
    const found = { shot: null, speed: null };
    pool.forEach((u) => {
      if (!changesOf(u).length) return;
      if (changesOf(u).some((c) => !isSetting(c))) found.shot = u; else found.speed = u;
    });
    return found;
  };
  let found = pick(after > 0 ? updates.filter((u) => typeof u.version === "number" && u.version > after) : updates);
  if (!found.shot && !found.speed) found = pick(updates);
  const shot = found.shot, speed = found.speed;
  const cause = shot || speed || updates[updates.length - 1] || null;
  const newest = updates[updates.length - 1];
  const pause = { version: cause ? cause.version : 0, latest: newest && typeof newest.version === "number" ? newest.version : 0, seen: [], changing: [], ease: false };
  if (cause) {
    const item = (entry) => (entry && typeof entry === "object")
      ? { text: clean(entry.text), kind: clean(entry.kind), why: clean(entry.why), field: clean(entry.field), where: clean(entry.where),
          value: clean(entry.value), count: entry.count, of: entry.of }
      : { text: clean(entry), kind: "", why: "", field: "", where: "" };
    const list = (lines) => (Array.isArray(lines) ? lines : []).map(item).filter((e) => e.text);
    const first = changesOf(cause)[0] || {};
    pause.ease = cause.direction === "down" || (first.kind === "fairness" && !/^settings\./.test(String(first.where || "")));

    /* left. Where the player stands is the game's footwork, not something the player chose. */
    const notChosen = { from: true, position: true, other_position: true, player_position: true };
    const tally = /^you (have )?(won|lost) (the last )?\d+ /i;   /* the score has its own place on the screen */
    const stood = /\b(left|middle|right)[ _](deep|short) on (\d+) of your \3 /i;   /* an older server names no field */
    const told = list(cause.seen);
    let seen = told.length ? told.filter((e) => !notChosen[e.field]) : list(cause.observations);
    if (!told.length) { const habits = seen.filter((e) => !(shot && tally.test(e.text)) && !stood.test(e.text)); if (habits.length) seen = habits; }
    if (told.length && shot) { const habits = seen.filter((e) => e.field !== "round_end"); if (habits.length) seen = habits; }
    seen.forEach((e) => { e.text = counted(e); });
    pause.seen = seen.slice(0, PAUSE_LINES);

    /* right */
    const setting = (e) => /^settings\./.test(e.where) || e.kind === "speed";
    let changing = list(cause.changing);
    if (changing.length) {
      if (shot && speed && shot.version < speed.version) changing = changing.concat(list(speed.changing).filter(setting));
      changing = changing.filter((e) => !setting(e)).concat(changing.filter(setting).slice(0, 1));
    } else {
      const fair = speed ? changesOf(speed).filter(isSetting)[0] : null;
      const why = fair ? cap(clean(fair.why).replace(/^fairness adjustment:\s*/i, "")) : "";
      const still = /\b(stay|stays|unchanged)\b/i;   /* a line that says nothing moves is not a change */
      const pace = /\b(speed|faster|slower|quicker|pace)\b/i;
      let plans = list(cause.plan);
      if (shot || why) plans = plans.filter((e) => !still.test(e.text));
      plans = plans.filter((e) => e.text.toLowerCase() !== why.toLowerCase());
      const said = plans.filter((e) => pace.test(e.text));   /* the plan already names the speed step: say it once */
      if (said.length) plans = plans.filter((e) => !pace.test(e.text));
      const step = said.length ? [{ text: said[0].text, kind: "speed", why: "", field: "", where: "" }] : why ? [{ text: why, kind: "speed", why: "", field: "", where: "" }] : [];
      changing = shot ? plans.concat(step) : step.concat(plans.slice(0, step.length ? 1 : PAUSE_LINES));
      if (shot && step.length) changing = plans.slice(0, PAUSE_LINES - 1).concat(step);
    }
    /* a speed step in a game's own words, said shorter */
    changing.forEach((e) => {
      if (setting(e)) e.text = e.text.replace(/^I (raise|lower) (?:the |my )?(?:opponent )?speed(?: by)?(?: a step| one step)?/i, (all, way) => /raise/i.test(way) ? "A step faster" : "A step slower");
    });
    /* an ease says so in its first line */
    if (changing[0] && /^that was too much|\b(backing|easing|back|ease) off\b/i.test(changing[0].text)) pause.ease = true;
    pause.changing = changing.slice(0, PAUSE_LINES);
  }

  const ids = Object.keys(models);
  const word = roundWord(setup);
  const say = (text) => {
    const out = readable(text, ids);
    if (word === "round") return out;
    return out.replace(/(?<![-\w])(r|R)ound(s?)\b/g, (all, first, many) => (first === "R" ? cap(word) : word) + many);
  };
  pause.seen.concat(pause.changing).forEach((e) => { e.text = say(short(e.text, 14)); e.why = say(short(e.why || "")); });
  left.habits.forEach((h) => { h.text = say(h.text); h.drives = say(h.drives); });
  if (left.why) left.why.text = say(left.why.text);
  if (left.like) left.like.text = say(left.like.text);
  right.noticed = right.noticed.map(say);
  right.plan = right.plan.map(say);
  right.about = say(right.about);
  right.fairness = say(right.fairness);
  if (right.check) right.check.said = say(right.check.said);

  return { waiting: !setup || !ready, left: left, right: right, pause: pause };
}

/* ---------- drawing ---------- */

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Where a line says the ball goes, as a spot on a small court: far side at the top. */
function spot(text) {
  const t = String(text || "").toLowerCase();
  const x = /\bleft\b/.test(t) ? 5.3 : /\bright\b/.test(t) ? 10.7 : 8;
  const y = /\bdeep\b|baseline/.test(t) ? 3.9 : /\bshort\b|\bnet\b/.test(t) ? 6.3 : 5;
  return '<circle class="fill" cx="' + x + '" cy="' + y + '" r="1.25"/>';
}

/* The picture for one line: what it is about, never a number. The game's own field or decision
   name comes first, then the kind, then the words. Of several shots named in one line, the first
   is the one it is about. */
function glyphOf(entry, fallback) {
  const kind = String(entry.kind || "").toLowerCase();
  const field = String(entry.field || "").toLowerCase();
  const where = String(entry.where || "").toLowerCase();
  const part = where.split(".").pop();
  const t = (String(entry.text || "") + " " + String(entry.value || "")).toLowerCase();
  if (/^settings\./.test(where)) return "speed";
  const named = { side: "racket", lands: "court", arm_zone: "eye", power: "power", backswing: "timing", initial_speed: "timing", early_guess: "timing",
    round_end: "score", aim: "court", position: "court", anticipate: "timing" };
  if (named[field]) return named[field];
  if (named[part]) return named[part];
  const byKind = { speed: "speed", camera: "eye", power: "power", timing: "timing", tell: "timing", anticipate: "timing", side: "racket",
    placement: "court", aim: "court", position: "court" };
  if (byKind[kind]) return byKind[kind];
  if (/\b(speed|faster|slower|quicker|pace)\b/.test(t)) return "speed";
  let shot = "", at = t.length;
  [["topspin", /topspin/], ["slice", /slic/], ["drop", /drop ?shot|drops? (it|the ball) short/], ["lob", /\blobs?\b/], ["flat", /\bflat\b/]].forEach((pair) => {
    const found = t.search(pair[1]);
    if (found >= 0 && found < at) { at = found; shot = pair[0]; }
  });
  if (shot) return shot;
  if (/forehand|backhand/.test(t)) return "racket";
  if (/\b(power|hard|harder|soft|softer)\b/.test(t)) return "power";
  if (/\b(swing\w*|early|late|timing|backswing|anticipat\w*|guess\w*)\b/.test(t)) return "timing";
  if (/\b(camera|arm|stance|lean\w*|body|reach\w*|shoulder)\b/.test(t)) return "eye";
  if (/\b(deep|short|left|right|middle|corner|aim\w*|court|land\w*|net|stand\w*|baseline|closer)\b/.test(t)) return "court";
  if (field === "shot_type" || part === "shot_type" || kind === "shot_type" || kind === "shot") return "racket";
  return fallback;
}

/* A counted line, said number first: "8 of your 10 shots were topspin". The server's own words otherwise. */
function counted(e) {
  if (!(typeof e.count === "number" && typeof e.of === "number" && e.of > 0) || !e.value) return e.text;
  const share = e.count + " of your " + e.of + " shots ";
  const value = lower(e.value);
  if (e.field === "shot_type") return share + "were " + value + (/shot$/.test(value) ? "s" : "");
  if (e.field === "side") return share + "came off your " + value;
  if (e.field === "lands") return share + "landed " + value;
  return e.text;
}

function icon(name, text) {
  const paths = {
    topspin: '<circle cx="8" cy="10" r="3"/><path d="M3 6.6a5.8 5.8 0 0 1 9.8-.6M13.2 3.2v3h-3"/>',
    slice: '<circle cx="8" cy="6" r="3"/><path d="M13 9.4a5.8 5.8 0 0 1-9.8.6M2.8 12.8v-3h3"/>',
    drop: '<path d="M8.2 9.2V14M1.8 13.2C3.4 5.4 8.4 3.8 10.6 10.6"/><circle class="fill" cx="11.2" cy="12.6" r="1.25"/>',
    lob: '<path d="M2 13.2C4.2 0.8 11.8 0.8 14 13.2"/><circle class="fill" cx="8" cy="3.9" r="1.25"/>',
    flat: '<circle cx="3.6" cy="8" r="1.7"/><path d="M7 8h7M11.4 5.4L14 8l-2.6 2.6"/>',
    racket: '<g transform="rotate(35 8 8)"><ellipse cx="8" cy="5.4" rx="3.5" ry="4.5"/><path d="M8 0.9v9M4.6 4.2h6.8M4.6 6.6h6.8M6.2 2.4v6M9.8 2.4v6" stroke-width="0.7"/><path d="M6.7 9.6L8 11.8l1.3-2.2M8 11.8v3.6"/></g>',
    speed: '<path d="M2.4 11.8a5.6 5.6 0 1 1 11.2 0M8 11.8l3-4.4"/>',
    power: '<path d="M9 1.8L3.8 9H8l-1 5.2L12.2 7H8z"/>',
    timing: '<circle cx="8" cy="9.2" r="4.8"/><path d="M8 9.2V6.4M6.4 2h3.2"/>',
    court: '<rect x="3" y="2" width="10" height="12" rx="0.6"/><path d="M3 8h10"/>' + spot(text),
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    plan: '<path d="M2.5 8h10.5M9.5 4.5L13 8l-3.5 3.5"/>',
    score: '<path d="M3.5 13V9M8 13V3.5M12.5 13V6.5"/>',
    held: '<path d="M3 8.6l3.2 3.2L13 4.8"/>',
    missed: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    fair: '<path d="M8 2.5v11M5 13.5h6M3.2 4.8h9.6M3.2 4.8L1.6 9a1.7 1.7 0 0 0 3.2 0L3.2 4.8zM12.8 4.8L11.2 9a1.7 1.7 0 0 0 3.2 0l-1.6-4.2z"/>',
    up: '<path d="M8 13V3.5M4.2 7.3L8 3.5l3.8 3.8"/>',
    down: '<path d="M8 3v9.5M4.2 8.7L8 12.5l3.8-3.8"/>',
    now: '<circle cx="8" cy="8" r="2"/>'
  };
  return '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">' + paths[name] + "</svg>";
}

const STYLE = `<style>
/* A game's column may have no padding of its own, so the panel keeps a little. A page can set --npc-pad. */
:host { display: block; box-sizing: border-box; padding: var(--npc-pad, 14px 16px); color: inherit; font: inherit; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.panel { display: flex; flex-direction: column; gap: 18px; font-size: 15px; line-height: 1.36; background: transparent;
  --accent: var(--npc-accent, #7dd3fc); --line: var(--npc-line, rgba(148, 163, 184, 0.24)); --dim: 0.74; --quiet: 0.64; --faint: 0.56; }
/* on a light background: a darker accent, and greys that keep 4.5 to 1 against white */
.panel.light { --accent: var(--npc-accent, #2563eb); --line: var(--npc-line, rgba(20, 20, 19, 0.15)); --dim: 0.82; --quiet: 0.72; --faint: 0.66; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.name, h3 { font-size: 10.5px; font-weight: 600; letter-spacing: 0.13em; text-transform: uppercase; }
.name { opacity: var(--dim); }
.loop { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: var(--faint); white-space: nowrap; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
h3 { display: flex; align-items: center; gap: 6px; opacity: var(--faint); margin-bottom: 9px; }
.ico { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
ul { list-style: none; display: grid; gap: 11px; }
.reads { gap: 11px; font-size: 14px; line-height: 1.3; }
.row { display: flex; align-items: baseline; gap: 8px; }
.label { flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.label .ico { display: inline-block; vertical-align: -2px; margin-right: 5px; opacity: 0.7; }
.num { flex: none; min-width: 34px; text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; opacity: var(--dim); }
.bar { display: block; height: 2px; margin-top: 5px; background: var(--line); }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.15s ease-out; }
/* the read that just changed most */
.moved .num { color: var(--accent); opacity: 1; font-weight: 600; }
.moved .num::before { content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 5px; border-radius: 50%; background: var(--accent); vertical-align: 1.5px; }
.so { display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; font-size: 12px; line-height: 1.35; opacity: var(--quiet); }
.like .label { display: block; }
.like .num { opacity: 1; }
.unsure { opacity: var(--faint); }
.unsure .bar i { background: currentColor; opacity: 0.55; }
.so .ico { width: 12px; height: 12px; margin-top: 2.5px; }
.so span { text-wrap: balance; }
.plan li { padding-left: 10px; border-left: 2px solid var(--accent); }
.quiet { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; line-height: 1.4; opacity: var(--quiet); }
.quiet .ico { margin-top: 2.5px; }
.check b { font-weight: 600; opacity: 1; }
.check.held { opacity: 0.92; }
.check.held .ico, .check.held b { color: var(--accent); }
.win { display: grid; gap: 7px; }
.win-top { display: flex; align-items: flex-end; gap: 10px; }
.win-big { font-size: 34px; line-height: 0.92; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.win-big small { font-size: 0.5em; font-weight: 500; margin-left: 1px; opacity: var(--dim); }
.win-side { display: grid; gap: 1px; padding-bottom: 1px; font-size: 12px; line-height: 1.3; opacity: var(--quiet); font-variant-numeric: tabular-nums; }
.chart { position: relative; height: 56px; }
.chart svg { position: absolute; left: 4px; top: 0; width: calc(100% - 8px); height: 100%; overflow: visible; }
.chart .goal { fill: none; stroke: currentColor; stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.42; vector-effect: non-scaling-stroke; }
.chart .trace { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.chart .now { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--accent); }
.fair { padding-top: 14px; border-top: 1px solid var(--line); }
.fair p { font-size: 14px; line-height: 1.4; }
.ico .fill { fill: currentColor; stroke: none; }
/* the pause screen: a game sets the paused attribute, and the panel turns into a few large lines.
   Sizes follow the panel's own width (--npc-w, kept current by the panel), so the lines fit a narrow
   rail and reach full size on a rail about 30% of the page wide. */
:host([paused]) { padding: var(--npc-pad-paused, clamp(16px, calc(var(--npc-w, 30vw) * 0.06 * ${PAUSE_PAD}), ${30 * PAUSE_PAD}px) clamp(16px, calc(var(--npc-w, 30vw) * 0.07 * ${PAUSE_PAD}), ${30 * PAUSE_PAD}px)); }
.paused { gap: clamp(16px, calc(var(--npc-w, 30vw) * 0.06), 28px); --tile: clamp(34px, calc(var(--npc-w, 30vw) * 0.116 * ${PAUSE_SIZE}), ${52 * PAUSE_SIZE}px); }
.paused header { padding-bottom: 12px; }
.paused .name { font-size: clamp(10.5px, calc(var(--npc-w, 30vw) * 0.029), 13px); }
.paused .loop { font-size: clamp(11px, calc(var(--npc-w, 30vw) * 0.029), 13px); }
.title { font-size: clamp(22px, calc(var(--npc-w, 30vw) * 0.084 * ${PAUSE_SIZE}), ${44 * PAUSE_SIZE}px); line-height: 1.08; font-weight: 650; letter-spacing: -0.022em; text-wrap: balance; }
.points { gap: clamp(16px, calc(var(--npc-w, 30vw) * 0.058), 34px); margin-top: 4px; }
.points li { display: grid; grid-template-columns: var(--tile) minmax(0, 1fr); gap: calc(var(--tile) * 0.36); align-items: start; animation: rise 0.45s ease both; }
.points li:nth-child(2) { animation-delay: 0.14s; }
.points li:nth-child(3) { animation-delay: 0.28s; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
.mark { display: grid; place-items: center; width: var(--tile); height: var(--tile); border-radius: calc(var(--tile) * 0.26); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 11%, transparent); }
.mark .ico { width: calc(var(--tile) * 0.56); height: calc(var(--tile) * 0.56); stroke-width: 1.35; }
.say { padding-top: 2px; font-size: clamp(17px, calc(var(--npc-w, 30vw) * 0.0635 * ${PAUSE_SIZE}), ${33 * PAUSE_SIZE}px); line-height: 1.2; font-weight: 500; letter-spacing: -0.012em; text-wrap: balance; }
.say b { font-weight: 700; color: var(--accent); white-space: nowrap; font-variant-numeric: tabular-nums; }
.say small { display: block; margin-top: 7px; font-size: 0.68em; line-height: 1.3; font-weight: 400; letter-spacing: 0; opacity: var(--quiet); }
.paused .none { font-size: clamp(17px, calc(var(--npc-w, 30vw) * 0.056), 26px); line-height: 1.25; opacity: var(--quiet); }
.mini { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.mini .win-big { font-size: 30px; }
.mini .win-side { font-size: 13px; padding-bottom: 0; }
.mini .chart { flex: 1 1 90px; min-width: 60px; height: 34px; }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } .bar i { transition: none; } .points li { animation: none; } }
</style>`;

function head(name, loop, thinking) {
  return '<header><span class="name">' + esc(name) + '</span><span class="loop">' +
    (thinking ? '<span class="dot"></span>' : "") + esc(loop) + "</span></header>";
}

function rateText(rate) { return rate > 0 ? rate.toFixed(1) + " reads/s" : "short loop"; }

function leftRow(h) {
  const pct = Math.round(h.value * 100);
  const glyph = h.kind ? glyphOf({ kind: h.camera || h.kind === "camera" ? "camera" : "", field: h.field, text: h.text }, "") : "";
  return '<li class="' + (h.unsure ? "unsure" : "") + '"><div class="row"><span class="label">' + (glyph ? icon(glyph, h.text) : "") +
    esc(h.text) + '</span><span class="num">' + pct + '%</span></div><span class="bar"><i style="width:' + pct + '%"></i></span>' +
    (h.drives ? '<span class="so">' + icon("plan") + "<span>" + esc(h.drives) + "</span></span>" : "") + "</li>";
}

/* The left panel as one string: used to build it, and to tell when its shape has changed. */
function leftHtml(left, ground, rows) {
  const open = '<section class="panel' + (ground === "light" ? " light" : "") + '">';
  if (!rows.length) {
    return open + head(left.title, "short loop", false) +
      '<p class="quiet">' + icon("now") + "<span>Waiting for your first shots.</span></p></section>";
  }
  return open + head(left.title, rateText(left.rate), false) + '<ul class="reads">' + rows.map(leftRow).join("") + "</ul>" +
    (left.like ? '<p class="quiet like">' + icon("now") + '<span class="label">' + esc(left.like.text) + '</span><span class="num">' +
      Math.round(left.like.value * 100) + "%</span></p>" : "") + "</section>";
}

/* The player's share of rounds, at the top of the right panel: the number, a small line of how it
   has moved, the target as a dashed line, and one plain sentence. */
function drawWin(win) {
  if (!win) return "";
  if (!win.rounds) return '<p class="quiet">' + icon("now") + "<span>No " + esc(win.words) + " finished yet.</span></p>";
  const pct = (v) => Math.round(v * 100);
  const few = win.rounds <= win.lastRounds;   /* fewer than ten played: the one number covers them all */
  const span = Math.max(win.series.length, 10) - 1;
  const y = (v) => 5 + (1 - Math.max(0, Math.min(1, v))) * 46;
  const points = win.series.map((v, i) => (i / span * 100).toFixed(1) + "," + y(v).toFixed(1));
  const last = win.series.length - 1;
  const side = few
    ? "<span>of " + win.rounds + " " + esc(win.rounds === 1 ? win.word : win.words) + " so far</span>"
    : "<span>of the last " + win.lastRounds + " " + esc(win.words) + "</span><span>" + pct(win.all) + "% of all " + win.rounds + "</span>";
  return '<div class="win"><div class="win-top"><span class="win-big">' + pct(win.share) + "<small>%</small></span>" +
    '<span class="win-side">' + side + "</span></div>" +
    '<div class="chart"><svg viewBox="0 0 100 56" preserveAspectRatio="none" aria-hidden="true">' +
    '<line class="goal" x1="0" x2="100" y1="' + y(win.target).toFixed(1) + '" y2="' + y(win.target).toFixed(1) + '"/>' +
    (points.length > 1 ? '<polyline class="trace" points="' + points.join(" ") + '"/>' : "") + "</svg>" +
    '<i class="now" style="left:calc(4px + (100% - 8px) * ' + (last / span).toFixed(4) + ");top:" + y(win.series[last]).toFixed(1) + 'px"></i></div>' +
    '<p class="quiet"><span>You win ' + pct(win.share) + "% of " + esc(win.words) + ". Target " + pct(win.target) + "%.</span></p></div>";
}

/* The same number, small, for the top of the pause screen. */
function drawWinMini(win) {
  if (!win || !win.rounds) return "";
  const pct = (v) => Math.round(v * 100);
  const few = win.rounds <= win.lastRounds;
  const span = Math.max(win.series.length, 10) - 1;
  const y = (v) => 4 + (1 - Math.max(0, Math.min(1, v))) * 26;
  const points = win.series.map((v, i) => (i / span * 100).toFixed(1) + "," + y(v).toFixed(1));
  const last = win.series.length - 1;
  return '<div class="win mini"><span class="win-big">' + pct(win.share) + "<small>%</small></span>" +
    '<span class="win-side">' + (few
      ? "<span>of " + win.rounds + " " + esc(win.rounds === 1 ? win.word : win.words) + " so far</span>"
      : "<span>of the last " + win.lastRounds + " " + esc(win.words) + "</span><span>" + pct(win.all) + "% of all " + win.rounds + "</span>") +
    "<span>Target " + pct(win.target) + "%</span></span>" +
    '<div class="chart"><svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">' +
    '<line class="goal" x1="0" x2="100" y1="' + y(win.target).toFixed(1) + '" y2="' + y(win.target).toFixed(1) + '"/>' +
    (points.length > 1 ? '<polyline class="trace" points="' + points.join(" ") + '"/>' : "") + "</svg>" +
    '<i class="now" style="left:calc(4px + (100% - 8px) * ' + (last / span).toFixed(4) + ");top:" + y(win.series[last]).toFixed(1) + 'px"></i></div></div>';
}

/* A count or a percent in a line stands out: "8 of your 10", "70%". */
function strong(text) {
  return esc(text).replace(/(\d+ (?:out )?of (?:(?:your|my|the) )?(?:last )?\d+|\d+(?:\.\d+)?%)/g, "<b>$1</b>");
}

/* The pause screen. Left: what was seen of the player. Right: what the opponent changes. */
function drawPaused(view, side, ground) {
  const right = side === "right";
  const pause = view.pause || { seen: [], changing: [] };
  const items = right ? pause.changing : pause.seen;
  const top = right ? head(view.right.title, "longer loop", false) + drawWinMini(view.right.win) : head(view.left.title, "short loop", false);
  const list = items.length
    ? '<ul class="points">' + items.map((e) => '<li><span class="mark">' + icon(glyphOf(e, right ? "plan" : "eye"), e.text) + '</span><span class="say">' +
        strong(e.text) + (e.why ? "<small>" + esc(e.why) + "</small>" : "") + "</span></li>").join("") + "</ul>"
    : '<p class="none">' + (right ? "Nothing to change yet. I am still watching." : "Not enough shots to go on yet.") + "</p>";
  return '<section class="panel paused' + (ground === "light" ? " light" : "") + '">' + top +
    '<h2 class="title">' + (right ? (pause.ease ? "I am easing off" : "What I am changing") : "What I saw you do") + "</h2>" + list + "</section>";
}

function drawRight(view, ground) {
  const right = view.right;
  let body = "";
  if (right.noticed.length) {
    body += "<div><h3>" + icon("eye") + "Noticed</h3><ul>" + right.noticed.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></div>";
  }
  if (right.plan.length) {
    body += "<div><h3>" + icon("plan") + 'Plan</h3><ul class="plan">' + right.plan.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></div>";
  }
  if (right.check) {
    body += '<p class="quiet check ' + (right.check.held ? "held" : "missed") + '">' + icon(right.check.held ? "held" : "missed") +
      "<span>Said " + esc(right.check.said.charAt(0).toLowerCase() + right.check.said.slice(1)) + ", <b>" +
      (right.check.held ? "held" : "didn't hold") + "</b></span></p>";
  }
  if (right.fairness) {
    body += '<div class="fair"><h3>' + icon("fair") + "Keeping it fair</h3><p>" + esc(right.fairness) + "</p></div>";
  }
  if (!body && right.about) body = '<p class="quiet">' + icon("now") + "<span>" + esc(right.about) + "</span></p>";
  if (!body) body = '<p class="quiet">' + icon("now") + "<span>Nothing to change yet.</span></p>";
  return '<section class="panel' + (ground === "light" ? " light" : "") + '">' + head(right.title, "longer loop", right.thinking) +
    drawWin(right.win) + body + "</section>";
}

/* ---------- the colour behind a panel ---------- */

/* "light" or "dark", from the nearest background that is really painted. "" when it cannot be read. */
function groundOf(node) {
  if (typeof getComputedStyle !== "function") return "";
  let at = node, hops = 0;
  while (at && hops++ < 60) {
    let colour = "";
    try { colour = String(getComputedStyle(at).backgroundColor || ""); } catch (error) { colour = ""; }
    const n = (colour.match(/-?[\d.]+/g) || []).map(Number);
    const unit = /^color\(/.test(colour) ? 255 : 1;   /* color(srgb 1 1 1) counts from 0 to 1 */
    if (/^(rgb|color\(srgb)/.test(colour) && n.length >= 3 && (n.length < 4 || n[3] >= 0.5)) {
      const lin = (v) => { v = Math.max(0, Math.min(255, v * unit)) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * lin(n[0]) + 0.7152 * lin(n[1]) + 0.0722 * lin(n[2]) > 0.3 ? "light" : "dark";
    }
    at = at.parentElement || (at.getRootNode && at.getRootNode().host) || null;
  }
  return "light";   /* nothing painted behind it: a page is white until told otherwise */
}

/* ---------- one stream, shared by every panel on the page ---------- */

const stream = {
  lines: [],             /* the lines of the match the panels follow */
  followed: null,        /* its id */
  matches: new Map(),    /* match id -> { lines, alive, played, left, seen } for every match on the server */
  last: "", clock: 0,
  /* this page's own match: the one whose setup was closest to the moment this script connected */
  own: null, ownHow: "", claimable: false,
  open: false, openedAt: 0,    /* the page's clock, in seconds, when the socket opened */
  offset: 0,                   /* the server's clock minus the page's, learned from the first live line */
  after: new Map(),      /* match id -> the update that was current when its last pause ended */
  resumed: false,
  panels: new Set(), socket: null, manual: false, tries: 0, timer: 0, queued: false
};
const MAX_MATCHES = 4;
const QUIET_MS = 20000;   /* a followed match this quiet can be passed by one that is being played */
const GONE_MS = 5000;     /* a game that left gets this long to come back before an idle match may take its place */
const OWN_S = 8;          /* a setup this close to the moment the script connected is this page's own match */
const LIVE_MS = 1500;     /* a line this long after the first one is no longer part of the history sent on joining */

function watchAddress() {
  const address = new URL("/watch", import.meta.url);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return address.href;
}

/* The match a panel is told to show, when its `match` attribute names one. */
function pinOf(panel) {
  return panel.hasAttribute && panel.hasAttribute("match") ? String(panel.getAttribute("match") || "") : "";
}

function redraw() {
  stream.queued = false;
  const views = new Map();
  stream.panels.forEach((panel) => {
    const pin = pinOf(panel);
    const id = pin || stream.followed;
    if (!views.has(id)) {
      const one = stream.matches.get(id);
      views.set(id, one && one.lines.length ? read(one.lines, stream.after.get(id) || 0) : null);
    }
    let view = views.get(id);
    if (view) view.left.rate = rateOf(stream.matches.get(id));
    /* told which match to show, and the server has not sent it yet: wait for it, show no other */
    if (pin && (!view || view.waiting) && (stream.open || stream.manual)) { view = read([]); view.waiting = false; }
    panel.draw(view);
  });
  if (stream.resumed) {
    stream.resumed = false;
    views.forEach((view, id) => { if (view && view.pause) stream.after.set(id, view.pause.latest); });
  }
}

/* Reads per second over the last 5 seconds, counted from the reads this page was sent. */
function rateOf(match) {
  if (!match) return 0;
  const end = stream.manual ? match.lastT : Date.now();
  return match.readAt.filter((at) => at > end - RATE_MS && at <= end).length / (RATE_MS / 1000);
}

/* Pick this page's own match by time: among the matches whose first setup was within 8 seconds of
   the moment the socket opened, the closest. Called again when a setup arrives or the clocks are compared. */
function claim() {
  if (stream.manual || !stream.claimable || !stream.openedAt || stream.ownHow === "restart") return;
  let best = null, gap = OWN_S;
  stream.matches.forEach((one, key) => {
    if (typeof one.setupAt !== "number") return;
    const away = Math.abs(one.setupAt - stream.offset - stream.openedAt);
    if (away <= gap) { gap = away; best = key; }
  });
  stream.own = best;
  stream.ownHow = best === null ? "" : "time";
}

function ask() {
  if (stream.queued) return;
  stream.queued = true;
  (window.requestAnimationFrame || setTimeout)(redraw);
}

/* The viewer socket carries every match on the server. Each match keeps its own lines, and the
   panels stay on the one they follow while its game is there. Another match takes over only when
   nothing is followed yet, when the followed game has left, when the followed match has had no
   player event and the other one gets one, or when the followed match has been quiet for 20
   seconds and the other one is being played. A setup from another tab alone never takes over.
   When the followed game leaves, a match that began around then or later takes over at once (a
   restart in one page). An older idle match waits 5 seconds first, so a game that drops and
   comes straight back keeps the panels.
   All of that gives way to this page's own match when there is one: the match whose setup was
   closest to the moment the script connected is followed, whatever else is on the server, until
   its game has left. A match that begins within 5 seconds of that (a restart in one page) is the
   page's own match from then on.
   A recording has no leaving lines, so a page that feeds one by hand keeps the simple rule:
   follow the match that last began or last had a player event. */
function feed(line, now, old) {
  const m = line && line.message;
  if (!m || !m.type || m.type === "frames") return;   /* pictures are not needed here */
  now = typeof now === "number" ? now : Date.now();
  const id = String(line.match || m.match_id || stream.last || "");
  stream.last = id;
  let match = stream.matches.get(id);
  /* a setup for a match already here is the game saying hello again: its lines stay.
     Only a new match id, or a recording with no ids at all, starts clean. */
  const again = !!match && m.type === "setup" && !!(line.match || m.match_id);
  if (!match || (m.type === "setup" && !again)) {
    /* known: its setup has been seen. A match picked up half way cannot be drawn, so it never takes over. */
    match = { lines: [], alive: ++stream.clock, born: stream.clock, bornAt: m.type === "setup" ? now : 0, known: false, played: 0, left: false, leftAt: 0, seen: now,
      readAt: [], lastT: 0 };
    stream.matches.set(id, match);
    if (m.type === "setup" && typeof line.at === "number") { match.setupAt = line.at; claim(); }
  }
  match.lines.push(line);
  /* when each read landed: by this page's clock when live, by the recording's own when played from a file */
  if (typeof line.t === "number") match.lastT = line.t * 1000;
  if (m.type === "player_read") {
    match.readAt.push(stream.manual ? match.lastT : now);
    if (match.readAt.length > 400) match.readAt.splice(0, 200);
  }
  /* a line from the history sent on joining says nothing about now, so it counts as long ago:
     of the matches already played, the one whose player acted last in the history is followed */
  match.seen = old ? now - QUIET_MS : now;
  const acted = m.type === "event" && m.by === "player";
  if (acted) { match.played += 1; match.alive = ++stream.clock; }
  const back = m.type === "setup" && match.left;   /* the same match again, after a reconnect */
  if (m.type === "setup") { match.left = false; match.known = true; }
  if (m.type === "trace" && m.stage === "server" && m.data && m.data.game === "left") { match.left = true; match.leftAt = now; }

  const followed = stream.matches.get(stream.followed);
  const own = stream.own === null ? null : stream.matches.get(stream.own);
  const wasOwn = stream.followed !== null && stream.followed === stream.own;
  if (stream.manual) {
    let best = null;
    stream.matches.forEach((one, key) => { if (best === null || one.alive > stream.matches.get(best).alive) best = key; });
    stream.followed = best;
  } else if (own && own.known && !own.left) {
    stream.followed = stream.own;
  } else if (!followed) {
    stream.followed = id;
  } else if (followed === match) {
    if (match.left) {
      /* its game has gone: a match that began just before is the same page starting again */
      let next = null;
      stream.matches.forEach((one, key) => {
        if (one.known && !one.left && now - one.bornAt <= GONE_MS && (next === null || one.born > stream.matches.get(next).born)) next = key;
      });
      if (next !== null) {
        stream.followed = next;
        if (wasOwn) { stream.own = next; stream.ownHow = "restart"; }
      }
    }
  } else if (match.known && !match.left && (
      (followed.left && (match.bornAt >= followed.leftAt || acted || now - followed.leftAt >= GONE_MS)) ||
      ((acted || back) && match.played > 0 && !followed.played) ||
      (match.played > 0 && now - followed.seen >= QUIET_MS))) {
    /* the page's own game left and a new one began straight after: the same page, starting again */
    if (wasOwn && followed.left && m.type === "setup" && now - followed.leftAt <= GONE_MS) { stream.own = id; stream.ownHow = "restart"; }
    stream.followed = id;
  }

  if (stream.matches.size > MAX_MATCHES) {
    const kept = new Set([stream.followed, id]);
    stream.panels.forEach((panel) => { kept.add(pinOf(panel)); });
    let oldest = null;
    stream.matches.forEach((one, key) => { if (!kept.has(key) && (oldest === null || one.alive < stream.matches.get(oldest).alive)) oldest = key; });
    if (oldest !== null) stream.matches.delete(oldest);
  }
  const now_followed = stream.matches.get(stream.followed);
  stream.lines = now_followed ? now_followed.lines : [];
  ask();
}

function forget() { stream.lines = []; stream.matches.clear(); stream.last = ""; stream.followed = null; }

function clear() { forget(); ask(); }

function connect() {
  if (stream.manual || stream.socket || !stream.panels.size) return;
  let socket;
  try { socket = new WebSocket(watchAddress()); } catch (error) { return; }
  stream.socket = socket;
  let fresh = true, joined = 0, compared = false;
  socket.onopen = () => {
    stream.open = true;
    stream.openedAt = Date.now() / 1000;
    stream.claimable = stream.own === null;   /* a page that already knows its match keeps it over a reconnect */
    ask();
  };
  socket.onmessage = (event) => {
    let line;
    try { line = JSON.parse(event.data); } catch (error) { return; }
    const heard = Date.now();
    if (fresh) { fresh = false; forget(); joined = heard; }   /* the server sends the match so far again */
    stream.tries = 0;
    /* the first line that is clearly live says how far the server's clock is from this page's */
    if (!compared && heard - joined >= LIVE_MS && typeof line.at === "number") {
      compared = true;
      const offset = line.at - heard / 1000;
      if (Math.abs(offset - stream.offset) > 1) { stream.offset = offset; claim(); }
    }
    feed(line, undefined, heard - joined < 1000);
  };
  socket.onerror = () => { try { socket.close(); } catch (error) { /* already closed */ } };
  socket.onclose = () => {
    if (stream.socket !== socket) return;
    stream.socket = null;
    stream.open = false;
    if (stream.manual) return;
    stream.tries += 1;
    if (stream.tries >= 4 && stream.matches.size) clear();   /* the server is gone: say nothing */
    clearTimeout(stream.timer);
    stream.timer = setTimeout(connect, Math.min(5000, 500 * Math.pow(2, Math.min(stream.tries, 4))));
  };
}

/* For a page that plays a recorded match: stop listening and take lines by hand. */
function manual() {
  stream.manual = true;
  stream.own = null; stream.ownHow = ""; stream.open = false;
  clearTimeout(stream.timer);
  if (stream.socket) { try { stream.socket.close(); } catch (error) { /* already closed */ } stream.socket = null; }
  clear();
}

class NpcPanel extends HTMLElement {
  static get observedAttributes() { return ["side", "match", "paused"]; }
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shape = "";
    this.rail = null;     /* the left panel's rows: which are shown, in which order, and since when */
    this.timer = 0;
    this.due = 0;
  }
  connectedCallback() {
    stream.panels.add(this);
    connect();
    /* the pause screen sizes its lines from the panel's own width */
    if (!this.sizer && typeof ResizeObserver === "function") {
      this.sizer = new ResizeObserver(() => {
        const wide = Math.round(this.getBoundingClientRect().width);
        if (wide > 0 && wide !== this.wide) { this.wide = wide; this.style.setProperty("--npc-w", wide + "px"); }
      });
      this.sizer.observe(this);
    }
    /* the reads-per-second line falls back to nothing when reads stop, so look again every second */
    if (!stream.tick && typeof setInterval === "function") stream.tick = setInterval(() => { if (stream.panels.size && stream.matches.size) ask(); }, 1000);
    ask();
  }
  disconnectedCallback() {
    stream.panels.delete(this); clearTimeout(this.timer); this.timer = 0;
    if (this.sizer) { this.sizer.disconnect(); this.sizer = null; this.wide = 0; }
  }
  attributeChangedCallback(name, before, now) {
    if (name === "paused" && before !== null && now === null) stream.resumed = true;
    this.shape = ""; this.rail = null; ask();
  }

  /* Draw again in a while, for something that changes with time alone. The soonest request wins. */
  later(ms) {
    const wait = Math.max(10, ms);
    const due = Date.now() + wait;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = 0; ask(); }, wait);
  }

  build(html) {
    this.shape = html;
    this.shadowRoot.innerHTML = html ? STYLE + html : "";
  }

  draw(view) {
    if (!view || view.waiting) {
      if (this.shape !== "" || this.shadowRoot.innerHTML !== "") this.build("");
      this.rail = null;
      return;
    }
    const ground = groundOf(this);
    if (this.hasAttribute("paused")) {
      /* the game is paused on an update: a few large lines, and nothing moves under them */
      const html = drawPaused(view, this.getAttribute("side") === "right" ? "right" : "left", ground);
      if (html !== this.shape) this.build(html);
      this.rail = null;
      return;
    }
    if (this.getAttribute("side") === "right") {
      const html = drawRight(view, ground);
      if (html !== this.shape) this.build(html);
      return;
    }
    this.drawLeft(view.left, ground);
  }

  /* The left panel is built as a whole only when its shape changes: which rows, their order, their
     words. A new value moves a bar and a number in place, so a row is never rebuilt as reads land. */
  drawLeft(left, ground) {
    const now = Date.now();
    if (!left.habits.length) {
      const html = leftHtml(left, ground, []);
      if (html !== this.shape) this.build(html);
      this.rail = null;
      return;
    }
    let rail = this.rail;
    if (!rail || rail.id !== left.id) {
      rail = this.rail = { id: left.id, order: [], data: {}, values: {}, key: "", orderedAt: now, movedAt: 0, marked: "", markedAt: 0, reads: left.reads, since: 0 };
    }
    const byName = {};
    left.habits.forEach((h) => { byName[h.name] = h; rail.data[h.name] = h; });

    /* a new read landed: which shown row changed most, and did any bar move at all */
    if (left.reads !== rail.reads) {
      let most = "", gap = 0.005, any = false;
      rail.order.forEach((n) => {
        if (!byName[n] || typeof rail.values[n] !== "number") return;
        const moved = Math.abs(byName[n].value - rail.values[n]);
        if (moved >= 0.005) any = true;
        if (moved > gap) { gap = moved; most = n; }
      });
      if (most) { rail.marked = most; rail.markedAt = now; }
      if (any) rail.movedAt = now;
      rail.reads = left.reads;
    }
    if (rail.marked && now - rail.markedAt >= MARK_MS) rail.marked = "";

    /* which rows, in which order: put in order at most once every 5 seconds. Before that a new
       read takes a free place at the end, and a row that fell out stays where it is, faint. */
    const wanted = left.habits.map((h) => h.name);
    let order = rail.order, sorted = false;
    if (!order.length) { order = wanted; sorted = true; }
    else if (wanted.join("|") !== order.join("|")) {
      if (now - rail.orderedAt >= HOLD_MS) { order = wanted; sorted = true; }
      else {
        order = order.slice();
        wanted.forEach((n) => { if (order.indexOf(n) < 0 && order.length < left.max) order.push(n); });
        this.later(HOLD_MS - (now - rail.orderedAt));
      }
    }
    const rows = order.map((n) => byName[n] || Object.assign({}, rail.data[n], { unsure: true, drives: "" })).filter((h) => h.name);
    const html = leftHtml(left, ground, rows);
    const key = html.replace(/<span class="num">\d+%<\/span>|width:\d+%/g, "").replace(/<span class="loop">[^<]*<\/span>/, "");
    if (key !== rail.key) {
      const moving = now - rail.movedAt < MOVE_MS;
      if (moving && rail.key && (!rail.since || now - rail.since < 600)) {
        /* never in the middle of a move: let the bars arrive first, but do not wait for ever */
        rail.since = rail.since || now;
        this.later(MOVE_MS - (now - rail.movedAt) + 10);
      } else {
        rail.order = rows.map((h) => h.name);
        rail.key = key;
        rail.since = 0;
        if (sorted) rail.orderedAt = now;
        Object.keys(rail.data).forEach((n) => { if (rail.order.indexOf(n) < 0) delete rail.data[n]; });
        this.build(html);
      }
    }

    /* the values, in place */
    const root = this.shadowRoot;
    const items = root.querySelectorAll(".reads > li");
    rail.order.forEach((n, i) => {
      const h = byName[n] || rail.data[n];
      if (!h) return;
      rail.values[n] = h.value;
      const li = items[i];
      if (!li) return;
      const pct = Math.round(h.value * 100) + "%";
      const bar = li.querySelector(".bar i"), num = li.querySelector(".num");
      if (bar && bar.style.width !== pct) bar.style.width = pct;
      if (num && num.textContent !== pct) num.textContent = pct;
      li.classList.toggle("moved", n === rail.marked);
    });
    const loop = root.querySelectorAll(".loop")[0];
    if (loop && loop.textContent !== rateText(left.rate)) loop.textContent = rateText(left.rate);
    const like = root.querySelectorAll(".like .num")[0];
    if (like && left.like) like.textContent = Math.round(left.like.value * 100) + "%";
    if (rail.marked) this.later(MARK_MS - (now - rail.markedAt) + 10);
  }
}

if (!customElements.get("npc-panel")) customElements.define("npc-panel", NpcPanel);

/* On purpose: one global, for a page that wants to feed the panels itself or draw its own. */
window.NpcPanels = {
  read: read,
  short: short,
  feed: feed,
  manual: manual,
  connected: () => !!stream.socket && stream.socket.readyState === 1
};

export { read, short };
