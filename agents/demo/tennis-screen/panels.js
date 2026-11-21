/* Side panels for a game's own live view.

   <npc-panel side="left">   the short loop: how this player plays right now
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
const MAX_DRIVES = 2;    /* at most this many habits also say what they drive, to keep the panel light */

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
  /* a one-word decision reads as a verb: "aims left short more". Anything else is said flat. */
  if (/^[a-z]+$/i.test(decision)) return "So the " + lower(pull.npc) + " " + third(decision) + " " + option + " " + way + ".";
  return cap(decision) + ": " + way + " " + option + ".";
}

/* Model ids read as names in every line: "gemini-4-neon" becomes "Gemini 4 Neon". */
function readable(text, ids) {
  let out = String(text == null ? "" : text);
  ids.slice().sort((a, b) => b.length - a.length).forEach((id) => { out = out.split(id).join(modelName(id)); });
  return out.replace(/\b[a-z]+(?:-[a-z0-9]+)*-\d+(?:\.\d+)?(?:-[a-z0-9]+)*\b/g, (id) => modelName(id));
}

/* The habits one read lists: the ones it is sure of, strongest first, then any that were
   listed before and that it is no longer sure of. Two values with one label show once. */
function listed(message, labels, shown) {
  const unsure = {};
  (Array.isArray(message.low_confidence) ? message.low_confidence : []).forEach((n) => { unsure[n] = true; });
  const values = message.values || {};
  const habits = [];
  Object.keys(values)
    .filter((n) => typeof values[n] === "number" && values[n] >= FLOOR && (!unsure[n] || shown[n]))
    .sort((a, b) => (unsure[a] ? 1 : 0) - (unsure[b] ? 1 : 0) || values[b] - values[a])
    .forEach((n) => {
      const text = short(labels[n] || cap(n));
      const same = habits.filter((h) => h.text.toLowerCase() === text.toLowerCase())[0];
      if (same) same.names.push(n);
      else if (habits.length < 3) {
        habits.push({ name: n, names: [n], text: text, value: Math.max(0, Math.min(1, values[n])), unsure: !!unsure[n], drives: "" });
      }
    });
  return habits;
}

function isSetting(change) {
  return !!change && (change.kind === "fairness" || /^settings\./.test(String(change.where || "")));
}

/* ---------- the logic: stream lines in, the words for each side out ---------- */

function read(lines) {
  let setup = null, ready = false, labels = {}, lastRead = null, updates = [], behaviour = null;
  let shown = {}, models = {};
  let writer = { model: "", open: false, about: "" };

  (lines || []).forEach((line) => {
    const m = line && line.message ? line.message : line;
    if (!m || !m.type) return;
    if (m.type === "setup") {
      /* a game sends setup again for the match it is already in: nothing starts over */
      if (setup && m.match_id != null && m.match_id === setup.match_id) { setup = m; return; }
      setup = m; ready = false; labels = {}; lastRead = null; updates = []; shown = {};
      behaviour = m.default_behaviour || null;
      writer = { model: "", open: false, about: "" };
      return;
    }
    if (setup && m.match_id && setup.match_id && m.match_id !== setup.match_id) return;

    if (m.type === "ready" || m.type === "strategy_update") {
      const values = (m.type === "ready" ? m.values : m.new_values) || {};
      Object.keys(values).forEach((name) => {
        const v = values[name] || {};
        labels[name] = v.label || v.about || cap(name);
      });
    }
    if (m.type === "ready") ready = true;
    if ((m.type === "ready" || m.type === "strategy_update") && m.behaviour) behaviour = m.behaviour;
    /* a read made before the player has done anything is a guess from the picture: not listed */
    if (m.type === "player_read" && !(typeof m.based_on_events === "number" && m.based_on_events <= 0)) {
      lastRead = m;
      listed(m, labels, shown).forEach((h) => { h.names.forEach((n) => { shown[n] = true; }); });
    }
    if (m.type === "trace" && m.model) models[m.model] = true;
    if (m.type === "strategy_update") { updates.push(m); writer.open = false; }
    if (m.type === "trace" && m.stage === "adapter") {
      if (m.model) writer.model = m.model;
      if (m.status === "start") { writer.open = true; writer.about = m.about || ""; }
      else if (m.status === "error") writer.open = false;
    }
  });

  /* left: the three strongest reads, what the opponent does about them, then what just moved */
  const left = { title: "Decisions API", habits: [], why: null };
  if (lastRead) {
    left.habits = listed(lastRead, labels, shown);
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
    noticed: [], plan: [], check: null, fairness: ""
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

  const ids = Object.keys(models);
  const say = (text) => readable(text, ids);
  left.habits.forEach((h) => { h.text = say(h.text); h.drives = say(h.drives); });
  if (left.why) left.why.text = say(left.why.text);
  right.noticed = right.noticed.map(say);
  right.plan = right.plan.map(say);
  right.about = say(right.about);
  right.fairness = say(right.fairness);
  if (right.check) right.check.said = say(right.check.said);

  return { waiting: !setup || !ready, left: left, right: right };
}

/* ---------- drawing ---------- */

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function icon(name) {
  const paths = {
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
    plan: '<path d="M2.5 8h10.5M9.5 4.5L13 8l-3.5 3.5"/>',
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
.habits { gap: 15px; }
.bar { display: block; height: 2px; margin-top: 7px; background: var(--line); }
.bar i { display: block; height: 100%; background: var(--accent); transition: width 0.5s ease; }
.so { display: flex; align-items: flex-start; gap: 6px; margin-top: 7px; font-size: 12.5px; line-height: 1.35; opacity: var(--quiet); }
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
.fair { padding-top: 14px; border-top: 1px solid var(--line); }
.fair p { font-size: 14px; line-height: 1.4; }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } .bar i { transition: none; } }
</style>`;

function head(name, loop, thinking) {
  return '<header><span class="name">' + esc(name) + '</span><span class="loop">' +
    (thinking ? '<span class="dot"></span>' : "") + esc(loop) + "</span></header>";
}

function drawLeft(view, ground) {
  const left = view.left;
  const open = '<section class="panel' + (ground === "light" ? " light" : "") + '">';
  if (!left.habits.length) {
    return open + head(left.title, "short loop", false) +
      '<p class="quiet">' + icon("now") + "<span>Waiting for your first shots.</span></p></section>";
  }
  let html = head(left.title, "short loop", false) + '<ul class="habits">' + left.habits.map((h) =>
    (h.unsure ? '<li class="unsure">' : "<li>") + esc(h.text) + '<span class="bar"><i style="width:' + Math.round(h.value * 100) + '%"></i></span>' +
    (h.drives ? '<span class="so">' + icon("plan") + "<span>" + esc(h.drives) + "</span></span>" : "") + "</li>").join("") + "</ul>";
  if (left.why) html += '<p class="quiet">' + icon(left.why.dir || "now") + "<span>" + esc(left.why.text) + "</span></p>";
  return open + html + "</section>";
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
  return '<section class="panel' + (ground === "light" ? " light" : "") + '">' + head(right.title, "longer loop", right.thinking) + body + "</section>";
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
  panels: new Set(), socket: null, manual: false, tries: 0, timer: 0, queued: false
};
const MAX_MATCHES = 4;
const QUIET_MS = 20000;   /* a followed match this quiet can be passed by one that is being played */
const GONE_MS = 5000;     /* a game that left gets this long to come back before an idle match may take its place */

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
    const id = pinOf(panel) || stream.followed;
    if (!views.has(id)) {
      const one = stream.matches.get(id);
      views.set(id, one && one.lines.length ? read(one.lines) : null);
    }
    panel.draw(views.get(id));
  });
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
    match = { lines: [], alive: ++stream.clock, born: stream.clock, bornAt: m.type === "setup" ? now : 0, known: false, played: 0, left: false, leftAt: 0, seen: now };
    stream.matches.set(id, match);
  }
  match.lines.push(line);
  /* a line from the history sent on joining says nothing about now, so it counts as long ago:
     of the matches already played, the one whose player acted last in the history is followed */
  match.seen = old ? now - QUIET_MS : now;
  const acted = m.type === "event" && m.by === "player";
  if (acted) { match.played += 1; match.alive = ++stream.clock; }
  const back = m.type === "setup" && match.left;   /* the same match again, after a reconnect */
  if (m.type === "setup") { match.left = false; match.known = true; }
  if (m.type === "trace" && m.stage === "server" && m.data && m.data.game === "left") { match.left = true; match.leftAt = now; }

  const followed = stream.matches.get(stream.followed);
  if (stream.manual) {
    let best = null;
    stream.matches.forEach((one, key) => { if (best === null || one.alive > stream.matches.get(best).alive) best = key; });
    stream.followed = best;
  } else if (!followed) {
    stream.followed = id;
  } else if (followed === match) {
    if (match.left) {
      /* its game has gone: a match that began just before is the same page starting again */
      let next = null;
      stream.matches.forEach((one, key) => {
        if (one.known && !one.left && now - one.bornAt <= GONE_MS && (next === null || one.born > stream.matches.get(next).born)) next = key;
      });
      if (next !== null) stream.followed = next;
    }
  } else if (match.known && !match.left && (
      (followed.left && (match.bornAt >= followed.leftAt || acted || now - followed.leftAt >= GONE_MS)) ||
      ((acted || back) && match.played > 0 && !followed.played) ||
      (match.played > 0 && now - followed.seen >= QUIET_MS))) {
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
  let fresh = true, joined = 0;
  socket.onmessage = (event) => {
    let line;
    try { line = JSON.parse(event.data); } catch (error) { return; }
    if (fresh) { fresh = false; forget(); joined = Date.now(); }   /* the server sends the match so far again */
    stream.tries = 0;
    feed(line, undefined, Date.now() - joined < 1000);
  };
  socket.onerror = () => { try { socket.close(); } catch (error) { /* already closed */ } };
  socket.onclose = () => {
    if (stream.socket !== socket) return;
    stream.socket = null;
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
  clearTimeout(stream.timer);
  if (stream.socket) { try { stream.socket.close(); } catch (error) { /* already closed */ } stream.socket = null; }
  clear();
}

class NpcPanel extends HTMLElement {
  static get observedAttributes() { return ["side", "match"]; }
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shape = "";
  }
  connectedCallback() { stream.panels.add(this); connect(); ask(); }
  disconnectedCallback() { stream.panels.delete(this); }
  attributeChangedCallback() { this.shape = ""; ask(); }
  draw(view) {
    const ground = !view || view.waiting ? "" : groundOf(this);
    const html = !view || view.waiting ? "" : this.getAttribute("side") === "right" ? drawRight(view, ground) : drawLeft(view, ground);
    /* when only the bars moved, slide them and leave the rest alone */
    const shape = html.replace(/width:\d+%/g, "");
    if (shape === this.shape && html) {
      const widths = html.match(/width:\d+%/g) || [];
      this.shadowRoot.querySelectorAll(".bar i").forEach((bar, i) => { if (widths[i]) bar.style.width = widths[i].slice(6); });
      return;
    }
    this.shape = shape;
    this.shadowRoot.innerHTML = html ? STYLE + html : "";
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
