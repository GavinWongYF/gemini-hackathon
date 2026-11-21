/* Second screen for the tennis demo.

   Reads the viewer stream and draws what the opponent's AI is seeing,
   concluding and changing. Every word and number on the page comes from a
   message on the stream.

   Live:   index.html                                  connects to the server that served it, else ws://<page host>:8000/watch
   Replay: index.html?replay=sample-stream.jsonl&speed=4   plays a recorded file (development only)
   Views:  this dense view shows with ?debug=1. The plain address goes to panels-test.html,
           the two side panels that plug into the game's own live view.
   Extra:  ?ws=ws://host:port/watch   another socket address
           ?at=42&hold=1              in a replay, jump to 42 seconds and stop there
           ?still=1                   no motion, for screenshots
*/
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var REPLAY = params.get("replay");
  var SPEED = Math.max(0.1, parseFloat(params.get("speed")) || 1);
  var AT = parseFloat(params.get("at"));
  var HOLD = params.get("hold") === "1";
  // Served by the agent server, the page uses that same address. Opened as a
  // file or from another server, it looks for the agent server on port 8000.
  var SAME_HOST = /^https?:$/.test(location.protocol) && location.pathname.indexOf("/screen") === 0;
  var WS_URL = params.get("ws") ||
    (SAME_HOST
      ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/watch"
      : "ws://" + (location.hostname || "localhost") + ":8000/watch");
  var SVGNS = "http://www.w3.org/2000/svg";
  var MIN_SURE = 0.6;
  var NBSP = String.fromCharCode(160);

  var COLS = { left: 0, middle: 1, right: 2 };
  var COURT = { x0: 10, x1: 390, top: 26, net: 280, bot: 534, short: 138 };
  var DECISION_WORD = { aim: "Aim", position: "Wait", shot_type: "Play" };
  var WRITERS = ["fast", "standard", "deep", "deepest"];

  var S = fresh();
  var court = null;

  function fresh() {
    return {
      setup: null, npc: null,
      meta: {}, order: [], values: {}, low: {}, read: null, shown: [],
      baseline: null, live: null, liveVersion: null, pending: null, latest: null, updates: [],
      delta: {}, deltaUntil: 0, pendingBase: null,
      inPoint: false, round: 0, roundVersion: {},
      events: [], rounds: [], measures: null,
      expectations: [], ruleText: {},
      lastOpp: null, shots: [],
      watcher: { model: "", ms: null },
      adapter: { open: false, startT: 0, model: "", ms: null, writer: "" },
      steps: [], log: [],
      streamT: 0, wallAt: 0
    };
  }

  /* ---------- small helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function words(s) { return String(s == null ? "" : s).replace(/_/g, " "); }

  function cap(s) { s = words(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  function isZone(z) {
    var p = String(z).split("_");
    return p.length === 2 && COLS[p[0]] != null && (p[1] === "short" || p[1] === "deep");
  }

  function zoneWords(z) {
    if (!isZone(z)) return words(z);
    var p = String(z).split("_");
    return p[1] + " " + p[0];
  }

  function signed(n) {
    if (typeof n !== "number") return "0";
    return (n > 0 ? "+" : "") + n.toFixed(2);
  }

  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    void node.getBoundingClientRect();
    node.classList.add(cls);
  }

  function svg(tag, attrs, parent) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  /* ---------- the same scoring the game uses when it picks ---------- */

  function dist(behaviour, decision, values) {
    var out = {};
    var options = (((behaviour || {}).npcs || {})[S.npc] || {}).decisions;
    options = (options || {})[decision] || {};
    var sum = 0;
    Object.keys(options).forEach(function (name) {
      var option = options[name] || {};
      var score = Number(option.base) || 0;
      var when = option.when || {};
      Object.keys(when).forEach(function (value) {
        score += Number(when[value]) * (Number(values[value]) || 0);
      });
      score = Math.max(0, score);
      out[name] = score;
      sum += score;
    });
    Object.keys(out).forEach(function (name) { out[name] = sum > 0 ? out[name] / sum : 0; });
    return out;
  }

  function top(d) {
    var best = null;
    Object.keys(d).forEach(function (name) { if (best === null || d[name] > d[best]) best = name; });
    return best;
  }

  function rules(behaviour) {
    var npc = ((behaviour || {}).npcs || {})[S.npc] || {};
    return Array.isArray(npc.rules) ? npc.rules : [];
  }

  function ruleKey(rule) {
    return JSON.stringify([rule.if || [], rule.do || {}]);
  }

  function ruleLine(rule) {
    if (S.ruleText[ruleKey(rule)]) return S.ruleText[ruleKey(rule)];
    if (rule && rule.why && S.ruleText[rule.why]) return S.ruleText[rule.why];
    var ifs = (rule.if || []).map(function (c) {
      var subject = words(c.fact || c.value);
      if (c.is != null) return subject + " is " + words(c.is);
      if (c.in) return subject + " is " + c.in.map(words).join(" or ");
      if (c.above != null) return subject + " is above " + c.above;
      if (c.below != null) return subject + " is below " + c.below;
      return subject;
    });
    var dos = Object.keys(rule.do || {}).map(function (d) { return words(d) + " " + words(rule.do[d]); });
    return "If " + ifs.join(" and ") + ", " + dos.join(", ") + ".";
  }

  /* ---------- messages ---------- */

  function handle(line) {
    if (!line || !line.message) return;
    var m = line.message;
    if (m.type !== "setup" && m.match_id && S.setup && S.setup.match_id && m.match_id !== S.setup.match_id) return;
    if (typeof line.t === "number") { S.streamT = line.t; S.wallAt = performance.now(); }
    try {
      if (m.type === "setup") onSetup(m);
      else if (m.type === "ready") onReady(m);
      else if (m.type === "event") onEvent(m);
      else if (m.type === "frames") onFrames(m);
      else if (m.type === "round_end") onRoundEnd(m);
      else if (m.type === "player_read") onRead(m);
      else if (m.type === "strategy_update") onUpdate(m);
      else if (m.type === "trace") onTrace(m);
    } catch (error) {
      if (window.console) console.warn("Could not show a message", m.type, error);
    }
  }

  function onSetup(m) {
    S = fresh();
    S.streamT = 0;
    S.wallAt = performance.now();
    S.setup = m;
    S.npc = Object.keys(m.npcs || {})[0] || "opponent";
    if (m.default_behaviour) {
      S.baseline = m.default_behaviour;
      S.live = m.default_behaviour;
      S.liveVersion = m.default_behaviour.version;
    }
    buildCourt();
    renderAll();
  }

  function addValues(values) {
    Object.keys(values || {}).forEach(function (name) {
      var v = values[name] || {};
      S.meta[name] = v.about || v.label || cap(name);
      if (S.order.indexOf(name) < 0) S.order.push(name);
    });
  }

  function onReady(m) {
    addValues(m.values);
    if (m.behaviour) {
      if (!S.baseline) S.baseline = m.behaviour;
      S.live = m.behaviour;
      S.liveVersion = m.behaviour.version;
    }
    renderAll();
  }

  function onEvent(m) {
    var used = m.behaviour_version != null ? m.behaviour_version : null;
    if (S.pending && (!S.inPoint || (used != null && used >= S.pending.version))) goLive();
    S.inPoint = true;
    if (typeof m.round === "number") {
      S.round = m.round;
      if (!(m.round in S.roundVersion)) S.roundVersion[m.round] = S.liveVersion;
    }
    S.events.push(m);
    var data = m.data || {};
    if (m.by === "player") {
      if (isZone(data.lands)) {
        S.shots.push({ zone: data.lands, seed: S.events.length, result: data.result });
        if (S.shots.length > 8) S.shots.shift();
        drawShots();
      }
    } else {
      var picked = m.picked || {};
      var aim = picked.aim || data.lands;
      S.lastOpp = {
        event: m,
        aim: aim,
        shot: picked.shot_type || data.shot_type,
        chance: dist(S.live, "aim", S.values)[aim]
      };
      drawPath(data.from, aim);
      renderLastShot();
      renderRules(m.by_rule && m.by_rule.length ? firedRule(m) : null);
    }
    renderTop();
    renderBottom();
  }

  function onFrames(m) {
    var views = m.views || {};
    var box = $("frames");
    var names = Object.keys((S.setup && S.setup.views) || {});
    Object.keys(views).forEach(function (name) { if (names.indexOf(name) < 0) names.push(name); });
    names.forEach(function (name) {
      var view = views[name];
      var node = document.getElementById("frame-" + name);
      if (!node) {
        node = document.createElement("div");
        node.className = "frame";
        node.id = "frame-" + name;
        node.innerHTML = '<div class="frame-box"><img alt=""></div><div class="frame-name">' + esc(name) + "</div>";
        box.appendChild(node);
      }
      if (view && view.data && /^image\//.test(view.mime_type || "image/jpeg")) {
        node.querySelector("img").src = "data:" + (view.mime_type || "image/jpeg") + ";base64," + view.data;
      }
    });
  }

  function onRoundEnd(m) {
    S.rounds.push(m);
    S.inPoint = false;
    if (S.pending) goLive();
    renderTop();
    renderBottom();
  }

  function onRead(m) {
    Object.keys(m.values || {}).forEach(function (name) {
      S.values[name] = m.values[name];
      if (!S.meta[name]) { S.meta[name] = cap(name); S.order.push(name); }
    });
    S.low = {};
    if (Array.isArray(m.low_confidence)) {
      m.low_confidence.forEach(function (name) { S.low[name] = true; });
    } else if (m.low_confidence && typeof m.low_confidence === "object") {
      Object.keys(m.low_confidence).forEach(function (name) { if (m.low_confidence[name]) S.low[name] = true; });
    } else if (m.confidence && typeof m.confidence === "object") {
      Object.keys(m.confidence).forEach(function (name) { if (m.confidence[name] < MIN_SURE) S.low[name] = true; });
    }
    S.read = m;
    fire("stage-reading");
    renderTop();
    renderRead();
    updatePlan(false);
  }

  function onUpdate(m) {
    S.latest = m;
    S.pending = m;
    S.steps = [];
    if (m.writer) S.adapter.writer = m.writer;
    S.updates.push(m);
    addValues(m.new_values);
    /* The plain words for a rule are in `changes`. Pair them with the rules this update added. */
    var worded = (m.changes || []).filter(function (c) {
      return /rules$/.test(String(c.where || "")) && typeof c.to === "string";
    });
    worded.forEach(function (c) { if (c.why) S.ruleText[c.why] = c.to; });
    var had = {};
    rules(S.pendingBase || S.live).forEach(function (rule) { had[ruleKey(rule)] = true; });
    var added = rules(m.behaviour).filter(function (rule) { return !had[ruleKey(rule)]; });
    if (added.length === worded.length) {
      added.forEach(function (rule, i) { S.ruleText[ruleKey(rule)] = worded[i].to; });
    }
    S.pendingBase = m.behaviour;
    (m.checks || []).forEach(function (check) {
      var found = null;
      S.expectations.forEach(function (x) {
        if (x.said === check.said && (check.version == null || x.version === check.version)) found = x;
      });
      if (!found) {
        found = { version: check.version, said: check.said };
        S.expectations.push(found);
      }
      found.state = check.held ? "held" : "missed";
      found.counts = checkCounts(check);
      found.at = S.expectations.length + m.version * 100;
    });
    (m.changes || []).forEach(function (c) {
      if (c.expect) S.expectations.push({ version: m.version, said: c.expect, state: "pending", at: m.version * 100 - 50 });
    });
    fire("stage-rewriting");
    renderTop();
    renderWhy();
  }

  function onTrace(m) {
    if (m.about && m.status !== "step" && m.stage !== "measures") {
      S.log = S.log.filter(function (entry) { return entry.stage !== m.stage; });
      S.log.push({ stage: m.stage, about: m.about, status: m.status });
      if (S.log.length > 4) S.log.shift();
      if (!S.latest && !S.steps.length) renderWhy();
    }
    if (m.stage === "watcher") {
      if (m.model) S.watcher.model = m.model;
      if (m.status === "done" && m.ms != null) S.watcher.ms = m.ms;
      fire("stage-watching");
      if (m.status !== "done") {
        Array.from(document.querySelectorAll(".frame")).forEach(function (n) { retrigger(n, "pulse"); });
      }
    } else if (m.stage === "adapter") {
      if (m.model) S.adapter.model = m.model;
      if (m.data && WRITERS.indexOf(m.data.writer) >= 0) S.adapter.writer = m.data.writer;
      if (m.status === "start") {
        S.adapter.open = true;
        S.adapter.startT = S.streamT;
        S.steps = [];
      } else if (m.status === "step") {
        S.adapter.open = true;
        S.steps.push({ about: m.about, kind: (m.data || {}).kind || "thought" });
        if (S.steps.length > 5) S.steps.shift();
        renderWhy();
      } else if (m.status === "done" || m.status === "error") {
        S.adapter.open = false;
        if (m.ms != null) S.adapter.ms = m.ms;
        if (S.steps.length) { S.steps = []; renderWhy(); }
      }
    } else if (m.stage === "measures" && m.data) {
      S.measures = m.data;
      renderBottom();
    }
    renderTop();
  }

  /* A new behaviour goes in at the gap between points, never during one. */
  function goLive() {
    var next = S.pending;
    S.pending = null;
    if (!next || !next.behaviour) return;
    var before = dist(S.live, "aim", S.values);
    S.live = next.behaviour;
    S.liveVersion = next.version != null ? next.version : next.behaviour.version;
    var after = dist(S.live, "aim", S.values);
    S.delta = {};
    Object.keys(after).forEach(function (zone) {
      var d = after[zone] - (before[zone] || 0);
      if (Math.abs(d) >= 0.01) S.delta[zone] = d;
    });
    S.deltaUntil = performance.now() + 9000;
    setTimeout(function () { updatePlan(false); }, 9100);
    updatePlan(true);
    retrigger($("slot-live"), "landed");
    renderTop();
    renderWhyTag();
  }

  /* ---------- top strip ---------- */

  function fire(id) {
    var node = $(id);
    node.classList.add("seen");
    retrigger(node, "fire");
  }

  function thinkingSeconds() {
    var extra = (performance.now() - S.wallAt) / 1000 * (REPLAY ? SPEED : 1);
    if (HOLD) extra = 0;
    return Math.max(0, S.streamT - S.adapter.startT + extra);
  }

  function renderTop() {
    var w = S.watcher;
    $("watching-detail").textContent = w.model ? w.model + (w.ms != null ? " | " + w.ms + " ms" : "") : NBSP;
    $("reading-detail").textContent = S.read && S.read.based_on_events != null
      ? "from " + S.read.based_on_events + " shots" : NBSP;

    var a = S.adapter;
    var detail = a.model || "";
    if (a.writer) detail += (detail ? " | " : "") + a.writer;
    if (a.open) detail += (detail ? " | " : "") + "thinking";
    else if (a.ms != null) detail += (detail ? " | " : "") + (a.ms / 1000).toFixed(1) + " s";
    $("rewriting-detail").textContent = detail || NBSP;
    var stage = $("stage-rewriting");
    stage.classList.toggle("open", a.open);
    if (a.open) stage.classList.add("seen");

    $("version").textContent = S.liveVersion != null ? "v" + S.liveVersion : NBSP;
    $("live-note").textContent = S.round ? "point " + S.round : NBSP;

    var slot = $("slot-next");
    slot.classList.toggle("ready", !!S.pending);
    slot.classList.toggle("thinking", !S.pending && a.open);
    if (S.pending) {
      $("next-value").textContent = "v" + S.pending.version + " ready";
      $("next-note").textContent = "goes in at the next point";
    } else if (a.open) {
      $("next-value").textContent = "thinking";
      $("next-note").textContent = (a.model ? a.model + " | " : "") + Math.floor(thinkingSeconds()) + " s";
    } else {
      $("next-value").textContent = NBSP;
      $("next-note").textContent = NBSP;
    }

    document.body.dataset.state = !S.setup ? "waiting" : S.pending ? "ready" : a.open ? "thinking" : "running";
  }

  /* ---------- left column ---------- */

  function renderRead() {
    var names = S.order.filter(function (n) { return n in S.values; });
    var ranked = names.slice().sort(function (a, b) {
      return ((S.low[b] ? 0 : 2) + S.values[b]) - ((S.low[a] ? 0 : 2) + S.values[a]);
    }).slice(0, 5);
    var show = names.filter(function (n) { return ranked.indexOf(n) >= 0; });
    var box = $("bars");
    if (show.join("|") !== S.shown.join("|")) {
      S.shown = show;
      box.innerHTML = show.map(function (name) {
        return '<div class="bar" data-name="' + esc(name) + '">' +
          '<div class="bar-top"><div class="bar-label">' + esc(S.meta[name]) + "</div>" +
          '<div class="bar-value"></div></div>' +
          '<div class="bar-track"><div class="bar-fill"></div></div></div>';
      }).join("");
    }
    Array.from(box.children).forEach(function (row) {
      var name = row.dataset.name;
      var value = Math.max(0, Math.min(1, Number(S.values[name]) || 0));
      var unsure = !!S.low[name];
      row.classList.toggle("unsure", unsure);
      row.querySelector(".bar-value").textContent = unsure ? "not sure yet" : value.toFixed(2);
      row.querySelector(".bar-fill").style.width = (value * 100).toFixed(1) + "%";
    });
    $("read-why").innerHTML = S.read && S.read.why ? "<span>What moved</span>" + esc(S.read.why) : "";
    $("picture-note").textContent = (S.read && S.read.picture_note) || NBSP;
    var left = document.querySelector(".col-left");
    fit(left, left);
  }

  /* ---------- the court ---------- */

  function zoneRect(zone, half) {
    var p = zone.split("_");
    var w = (COURT.x1 - COURT.x0) / 3;
    var x = COURT.x0 + COLS[p[0]] * w;
    var y, h;
    if (half === "bottom") {
      if (p[1] === "short") { y = COURT.net; h = COURT.short; }
      else { y = COURT.net + COURT.short; h = COURT.bot - y; }
    } else if (p[1] === "short") { y = COURT.net - COURT.short; h = COURT.short; }
    else { y = COURT.top; h = COURT.net - COURT.short - COURT.top; }
    return { x: x, y: y, w: w, h: h, cx: x + w / 2, cy: y + h / 2 };
  }

  function buildCourt() {
    var wrap = $("court-wrap");
    var old = wrap.querySelector("svg");
    if (old) wrap.removeChild(old);
    var root = svg("svg", { viewBox: "0 0 400 560", preserveAspectRatio: "xMinYMin meet" }, wrap);
    court = { root: root, zones: {}, dots: null };

    var zones = (((S.setup || {}).lists || {}).zone || []).filter(isZone);
    var fills = svg("g", {}, root);
    zones.forEach(function (zone) {
      var r = zoneRect(zone, "bottom");
      court.zones[zone] = {
        rect: r,
        fill: svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, "class": "zone-fill" }, fills)
      };
    });

    var w = (COURT.x1 - COURT.x0) / 3;
    [1, 2].forEach(function (i) {
      svg("line", { x1: COURT.x0 + i * w, y1: COURT.top, x2: COURT.x0 + i * w, y2: COURT.bot, "class": "c-grid" }, root);
    });
    svg("rect", { x: COURT.x0, y: COURT.top, width: COURT.x1 - COURT.x0, height: COURT.bot - COURT.top, "class": "c-line" }, root);
    [COURT.net - COURT.short, COURT.net + COURT.short].forEach(function (y) {
      svg("line", { x1: COURT.x0, y1: y, x2: COURT.x1, y2: y, "class": "c-line" }, root);
    });
    svg("line", { x1: COURT.x0 - 8, y1: COURT.net, x2: COURT.x1 + 8, y2: COURT.net, "class": "c-line c-net" }, root);

    svg("text", { x: COURT.x0, y: COURT.top - 9, "class": "c-side" }, root).textContent = "Opponent";
    svg("text", { x: COURT.x0, y: COURT.bot + 18, "class": "c-side" }, root).textContent = "You";

    court.waitBox = svg("rect", { x: 0, y: 0, width: 0, height: 0, "class": "wait-box", visibility: "hidden" }, root);
    court.waitText = svg("text", { x: 0, y: 0, "class": "wait-text", visibility: "hidden" }, root);
    court.dots = svg("g", {}, root);
    court.path = svg("line", { "class": "shot-path" }, root);
    court.ring = svg("circle", { r: 7, "class": "shot-ring" }, root);

    zones.forEach(function (zone) {
      var z = court.zones[zone];
      var r = z.rect;
      z.pct = svg("text", { x: r.cx, y: r.cy + 6, "class": "zone-pct" }, root);
      z.delta = svg("text", { x: r.cx, y: r.cy + 26, "class": "zone-delta" }, root);
      z.flash = svg("rect", { x: r.x + 1, y: r.y + 1, width: r.w - 2, height: r.h - 2, "class": "zone-flash" }, root);
    });
  }

  function updatePlan(flash) {
    if (!court) return;
    var aim = dist(S.live, "aim", S.values);
    var showDelta = performance.now() < S.deltaUntil;
    Object.keys(court.zones).forEach(function (zone) {
      var z = court.zones[zone];
      var p = aim[zone];
      if (p == null) {
        z.fill.style.fillOpacity = 0;
        z.pct.textContent = "";
        z.delta.classList.remove("show");
        return;
      }
      var opacity = Math.min(0.92, 0.04 + p * 1.75);
      z.fill.style.fillOpacity = opacity.toFixed(3);
      z.pct.textContent = Math.round(p * 100) + "%";
      z.pct.classList.toggle("dark", opacity > 0.55);
      z.delta.classList.toggle("dark", opacity > 0.55);
      var d = S.delta[zone];
      if (showDelta && d) {
        z.delta.textContent = (d > 0 ? "+" : "") + Math.round(d * 100);
        z.delta.classList.add("show");
        if (flash) retrigger(z.flash, "go");
      } else {
        z.delta.classList.remove("show");
      }
    });

    var position = dist(S.live, "position", S.values);
    var best = top(position);
    if (best && isZone(best)) {
      var r = zoneRect(best, "top");
      court.waitBox.setAttribute("x", r.x + 8);
      court.waitBox.setAttribute("y", r.y + 8);
      court.waitBox.setAttribute("width", r.w - 16);
      court.waitBox.setAttribute("height", r.h - 16);
      court.waitBox.setAttribute("visibility", "visible");
      court.waitText.setAttribute("x", r.cx);
      court.waitText.setAttribute("y", r.y + 24);
      court.waitText.setAttribute("visibility", "visible");
      court.waitText.textContent = "waits " + Math.round(position[best] * 100) + "%";
    }

    var mix = dist(S.live, "shot_type", S.values);
    $("mix").innerHTML = Object.keys(mix).map(function (name) {
      return '<div class="mix-row"><div class="mix-name">' + esc(cap(name)) + "</div>" +
        '<div class="mix-track"><div class="mix-fill" style="width:' + (mix[name] * 100).toFixed(1) + '%"></div></div>' +
        '<div class="mix-value">' + Math.round(mix[name] * 100) + "%</div></div>";
    }).join("");

    $("plan-tag").innerHTML = S.liveVersion != null ? "<b>v" + esc(S.liveVersion) + "</b> live" : "";
    renderRules(null);
  }

  function firedRule(event) {
    var picked = event.picked || {};
    var found = null;
    rules(S.live).forEach(function (rule) {
      (event.by_rule || []).forEach(function (decision) {
        if (!found && rule.do && rule.do[decision] === picked[decision]) found = rule;
      });
    });
    return found;
  }

  function renderRules(fired) {
    var list = rules(S.live);
    var box = $("rules");
    var key = list.map(function (r) { return r.why || JSON.stringify(r.do); }).join("|");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = list.length
        ? list.slice(0, 3).map(function (rule) { return '<div class="rule">' + esc(ruleLine(rule)) + "</div>"; }).join("")
        : '<div class="empty">None yet. It is choosing by weight.</div>';
    }
    if (fired) {
      var index = list.indexOf(fired);
      if (index >= 0 && box.children[index]) retrigger(box.children[index], "fired");
    }
  }

  function jitter(seed, salt) {
    var x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  }

  function drawShots() {
    if (!court) return;
    while (court.dots.firstChild) court.dots.removeChild(court.dots.firstChild);
    S.shots.forEach(function (shot, i) {
      var r = zoneRect(shot.zone, "top");
      var age = S.shots.length - 1 - i;
      var attrs = {
        cx: r.cx + jitter(shot.seed, 1) * (r.w - 34),
        cy: r.cy + 10 + jitter(shot.seed, 2) * (r.h - 56),
        r: 3.5,
        "class": "shot-dot",
        opacity: Math.max(0.22, 1 - age * 0.12).toFixed(2)
      };
      var dot = svg("circle", attrs, court.dots);
      if (shot.result && shot.result !== "in") {
        dot.setAttribute("style", "fill:none;stroke:#f1f1f1;stroke-width:1");
      }
    });
  }

  function drawPath(from, to) {
    if (!court || !isZone(to)) return;
    var b = zoneRect(to, "bottom");
    var a = isZone(from) ? zoneRect(from, "top") : { cx: (COURT.x0 + COURT.x1) / 2, cy: COURT.top + 30 };
    court.path.setAttribute("x1", a.cx);
    court.path.setAttribute("y1", a.cy);
    court.path.setAttribute("x2", b.cx);
    court.path.setAttribute("y2", b.cy - 22);
    court.ring.setAttribute("cx", b.cx);
    court.ring.setAttribute("cy", b.cy - 22);
    retrigger(court.path, "go");
    retrigger(court.ring, "go");
  }

  function renderLastShot() {
    var last = S.lastOpp;
    if (!last) {
      $("shot-line").innerHTML = "&nbsp;";
      $("shot-why").innerHTML = "&nbsp;";
      $("shot-base").innerHTML = "&nbsp;";
      return;
    }
    var event = last.event;
    var byRule = event.by_rule || [];
    var line = esc(cap(last.shot)) + " to " + esc(zoneWords(last.aim));
    if (byRule.length) line += '<span class="by-rule">rule</span>';
    $("shot-line").innerHTML = line;

    var why;
    if (byRule.length) {
      var rule = firedRule(event);
      why = "A rule chose the " + byRule.map(words).join(" and ") + ". " + (rule && rule.why ? rule.why : "");
    } else if (last.chance != null) {
      why = "Chosen by weight. " + cap(zoneWords(last.aim)) + " was " + Math.round(last.chance * 100) + "% likely.";
    } else {
      why = "Chosen by weight.";
    }
    $("shot-why").textContent = why;

    if (S.baseline) {
      var shot = top(dist(S.baseline, "shot_type", S.values));
      var aim = top(dist(S.baseline, "aim", S.values));
      $("shot-base").textContent = "The unchanged opponent would have played " + words(shot) + " to " + zoneWords(aim) + ".";
    }
  }

  /* ---------- right column ---------- */

  var MARK = {
    held: '<svg class="mark" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5"/><path d="M6 10.4l2.8 2.8L14.2 7.4"/></svg>',
    missed: '<svg class="mark" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5"/><path d="M7 7l6 6M13 7l-6 6"/></svg>',
    pending: '<svg class="mark" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5"/></svg>'
  };

  function termDiff(from, to) {
    from = from && typeof from === "object" ? from : {};
    to = to && typeof to === "object" ? to : {};
    var out = [];
    var effect = 0;
    if ((from.base || 0) !== (to.base || 0)) {
      out.push("base " + signed(from.base || 0) + " > " + signed(to.base || 0));
      effect += (to.base || 0) - (from.base || 0);
    }
    var a = from.when || {};
    var b = to.when || {};
    Object.keys(b).concat(Object.keys(a).filter(function (k) { return !(k in b); })).forEach(function (name) {
      if (a[name] === b[name]) return;
      out.push("when " + words(name) + " " + (name in a ? signed(a[name]) : "new") + " > " + (name in b ? signed(b[name]) : "gone"));
      effect += ((b[name] || 0) - (a[name] || 0)) * (Number(S.values[name]) || 0);
    });
    return { lines: out, effect: effect };
  }

  function changeItem(c) {
    var where = String(c.where || "");
    var parts = where.split(".");
    var html = "";
    if (/rules$/.test(where)) {
      var label = c.from == null ? "New rule" : c.to == null ? "Rule removed" : "Rule changed";
      var text = typeof c.to === "string" ? c.to : typeof c.from === "string" ? c.from : "";
      html = '<div class="change-top"><div class="change-what">' + esc(text) + '</div><div class="change-diff">' + label + "</div></div>";
    } else if (parts[0] === "settings") {
      html = '<div class="change-top"><div class="change-what">' + esc(cap(parts.slice(1).join(" "))) + "</div>" +
        '<div class="change-diff"><span class="from">' + esc(c.from) + "</span> &gt; " + esc(c.to) + "</div></div>";
    } else {
      var decision = parts[1] || "";
      var option = parts[2] || "";
      var diff = termDiff(c.from, c.to);
      var direction = diff.effect > 0.0005 ? "more often" : diff.effect < -0.0005 ? '<span class="from">less often</span>' : "";
      html = '<div class="change-top"><div class="change-what">' +
        esc((DECISION_WORD[decision] || cap(decision)) + " " + zoneWords(option)) + "</div>" +
        '<div class="change-diff">' + direction + "</div></div>";
      if (diff.lines.length) html += '<div class="change-terms">' + esc(diff.lines.slice(0, 2).join(" | ")) + "</div>";
    }
    if (c.why) html += '<div class="change-why">' + esc(c.why) + "</div>";
    return "<li>" + html + "</li>";
  }

  function favourite() {
    var habits = (S.measures && S.measures.habits) || [];
    for (var i = 0; i < habits.length; i++) if (habits[i].field !== "result") return habits[i];
    return null;
  }

  /* Uses of the favourite play in finished points, and how many of those points the player won. */
  function habitCounts(habit, keep) {
    var won = {};
    S.rounds.forEach(function (r) { won[r.round] = r.winner === "player"; });
    var uses = 0, wins = 0;
    S.events.forEach(function (e) {
      if (e.by !== "player" || e.name !== habit.event || !(e.round in won)) return;
      if ((e.data || {})[habit.field] !== habit.value) return;
      if (keep && !keep(S.roundVersion[e.round])) return;
      uses += 1;
      if (won[e.round]) wins += 1;
    });
    return { uses: uses, wins: wins };
  }

  function checkCounts(check) {
    if (check.measure !== "habit_payoff" || check.version == null) return "";
    var change = null;
    S.updates.forEach(function (u) {
      if (u.version !== check.version) return;
      (u.changes || []).forEach(function (c) { if (c.expect === check.said) change = c; });
    });
    var habit = change && change.habit && typeof change.habit === "object" ? change.habit : favourite();
    if (!habit) return "";
    var before, since;
    if (change && typeof change.after_round === "number") {
      var won = {};
      S.rounds.forEach(function (r) { won[r.round] = r.winner === "player"; });
      before = { uses: 0, wins: 0 };
      since = { uses: 0, wins: 0 };
      S.events.forEach(function (e) {
        if (e.by !== "player" || e.name !== habit.event || !(e.round in won)) return;
        if ((e.data || {})[habit.field] !== habit.value) return;
        var side = e.round <= change.after_round ? before : since;
        side.uses += 1;
        if (won[e.round]) side.wins += 1;
      });
    } else {
      before = habitCounts(habit, function (v) { return v < check.version; });
      since = habitCounts(habit, function (v) { return v >= check.version; });
    }
    if (!before.uses && !since.uses) return "";
    return before.wins + " of " + before.uses + " before, " + since.wins + " of " + since.uses + " since";
  }

  function testedLine(tested) {
    if (tested == null || tested === false) return "";
    if (typeof tested === "string") return tested;
    var n = typeof tested === "number" ? tested
      : Array.isArray(tested) ? tested.length
      : Array.isArray(tested.candidates) ? tested.candidates.length
      : tested.rule_sets != null ? tested.rule_sets
      : tested.count != null ? tested.count
      : tested.total != null ? tested.total : null;
    if (Array.isArray(n)) n = n.length;
    return n != null ? "Tested " + n + " rule sets, kept the best." : "Tested before it went in.";
  }

  function renderWhyTag() {
    var tag = $("why-tag");
    var u = S.latest;
    if (!u) { tag.innerHTML = ""; tag.className = "tag"; return; }
    var ready = S.pending === u;
    tag.className = "tag" + (ready ? " ready" : "");
    tag.innerHTML = "<b>v" + esc(u.version) + "</b> " + (ready ? "ready | goes in at the next point" : "live");
  }

  var STEP_WORD = { writing: "writing", testing: "testing", blocked: "blocked", approved: "approved", thought: "" };

  function renderWhy() {
    var box = $("why");
    renderWhyTag();

    if (S.adapter.open && S.steps.length) {
      box.innerHTML = '<div class="why-block"><h3>Writing and testing</h3><ul class="why-list steps">' +
        S.steps.map(function (step) {
          var kind = STEP_WORD[step.kind] != null ? step.kind : "thought";
          var loud = kind === "approved" || kind === "blocked";
          var mark = kind === "approved" ? MARK.held : kind === "blocked" ? MARK.missed : MARK.pending;
          return '<li class="check step ' + (kind === "approved" ? "held" : kind === "blocked" ? "missed" : "pending") + '">' +
            mark + '<div class="check-said">' + esc(step.about) + "</div>" +
            (loud ? '<div class="check-meta"><b>' + kind + "</b></div>" : "") + "</li>";
        }).join("") + "</ul></div>";
      return;
    }

    if (!S.latest) {
      var first = "";
      if (S.setup && S.setup.goal) {
        first += '<div class="why-block"><h3>Its goal</h3><div class="goal">' + esc(S.setup.goal) + "</div></div>";
      }
      if (S.log.length) {
        first += '<div class="why-block"><h3>So far</h3><ul class="why-list quiet">' + S.log.map(function (entry) {
          return "<li" + (entry.status === "start" ? ' class="doing"' : "") + ">" + esc(entry.about) + "</li>";
        }).join("") + "</ul></div>";
      }
      if (box.dataset.first !== first) { box.dataset.first = first; box.innerHTML = first; }
      return;
    }
    box.dataset.first = "";

    var u = S.latest;
    var html = "";

    var seen = (u.observations || []).slice(0, 3);
    if (seen.length) {
      html += '<div class="why-block"><h3>Noticed</h3><ul class="why-list">' +
        seen.map(function (line) { return '<li class="plain">' + esc(line) + "</li>"; }).join("") + "</ul></div>";
    }

    var changes = (u.changes || []).slice(0, 3);
    var tested = testedLine(u.tested);
    if (changes.length || tested) {
      html += '<div class="why-block"><h3>Changing</h3><ul class="why-list">' + changes.map(changeItem).join("") + "</ul>" +
        (tested ? '<div class="tested">' + esc(tested) + "</div>" : "") + "</div>";
    }

    var checks = S.expectations.slice().sort(function (a, b) { return b.at - a.at; }).slice(0, 3);
    if (checks.length) {
      html += '<div class="why-block"><h3>Checking</h3><ul class="why-list">' + checks.map(function (x) {
        var word = x.state === "held" ? "held" : x.state === "missed" ? "did not hold" : "waiting for more points";
        return '<li class="check ' + x.state + '">' + MARK[x.state] +
          '<div class="check-said">' + esc(x.said) + "</div>" +
          '<div class="check-meta"><b>' + word + "</b>" +
          (x.counts ? ' <span class="n">| ' + esc(x.counts) + "</span>" : "") +
          (x.version != null ? " | from v" + esc(x.version) : "") + "</div></li>";
      }).join("") + "</ul></div>";
    }
    box.innerHTML = html;
    fit(box, box);
  }

  /* Long lines from the model: step the type down before anything is cut off. */
  function fit(node, measured) {
    node.classList.remove("tight", "tighter");
    if (measured.scrollHeight <= measured.clientHeight + 1) return;
    node.classList.add("tight");
    if (measured.scrollHeight <= measured.clientHeight + 1) return;
    node.classList.add("tighter");
  }

  /* ---------- bottom strip ---------- */

  function playName(habit) {
    var v = habit.value;
    if (habit.field === "lands" && isZone(v)) {
      var p = v.split("_");
      return cap(p[1]) + (p[0] === "middle" ? " down the middle" : " to the " + p[0]);
    }
    if (habit.field === "from" && isZone(v)) return "Hitting from " + zoneWords(v);
    if (habit.field === "arm_zone") return "Racket arm on the " + words(v);
    if (habit.field === "side" || habit.field === "shot_type") return "The " + words(v);
    return cap(habit.field) + " " + words(v);
  }

  function renderBottom() {
    var habit = favourite();
    if (habit) {
      var total = S.events.filter(function (e) {
        return e.by === "player" && e.name === habit.event && (e.data || {})[habit.field] != null;
      }).length;
      var uses = S.events.filter(function (e) {
        return e.by === "player" && e.name === habit.event && (e.data || {})[habit.field] === habit.value;
      }).length;
      $("fav-name").textContent = playName(habit);
      $("fav-detail").innerHTML = '<span class="n">' + uses + " of " + total + "</span> shots so far";
    } else {
      $("fav-name").innerHTML = "&nbsp;";
      $("fav-detail").innerHTML = "&nbsp;";
    }

    var won = {};
    S.rounds.forEach(function (r) { won[r.round] = r.winner; });
    var versions = [];
    Object.keys(S.roundVersion).map(Number).sort(function (a, b) { return a - b; }).forEach(function (round) {
      var v = S.roundVersion[round];
      var col = versions.filter(function (x) { return x.v === v; })[0];
      if (!col) { col = { v: v, points: [] }; versions.push(col); }
      col.points.push(won[round] || null);
    });
    var row = $("version-row");
    var shown = versions.slice(-7);
    var grew = shown.length > Number(row.dataset.count || 0);
    var html = shown.map(function (col, index) {
      var count = habit ? habitCounts(habit, function (v) { return v === col.v; }) : null;
      var finished = col.points.some(function (p) { return p; });
      var text = !count || !finished ? '<div class="vcol-count none">in play</div>'
        : '<div class="vcol-count">' + count.wins + " <small>of</small> " + count.uses + "</div>";
      return '<div class="vcol' + (col.v === S.liveVersion ? " live" : "") +
        (grew && index === shown.length - 1 ? " new" : "") + '">' +
        '<div class="vcol-v">v' + esc(col.v) + (col.v === S.liveVersion ? " live" : "") + "</div>" + text +
        '<div class="vcol-points">' + col.points.map(function (p) {
          return '<span class="pt ' + (p === "player" ? "player" : p ? "opponent" : "") + '"></span>';
        }).join("") + "</div></div>";
    }).join("");
    if (row.dataset.html !== html) {
      row.dataset.html = html;
      row.dataset.count = shown.length;
      row.innerHTML = html;
    }

    var mine = S.rounds.filter(function (r) { return r.winner === "player"; }).length;
    var theirs = S.rounds.length - mine;
    $("points-score").innerHTML =
      '<span><span class="n">' + mine + '</span><span class="points-key"></span>you</span>' +
      '<span class="opp"><span class="n">' + theirs + '</span><span class="points-key opp"></span>opponent</span>';
    $("points-detail").innerHTML = S.rounds.length
      ? 'You won <span class="n">' + mine + " of " + S.rounds.length + "</span> points"
      : "&nbsp;";
  }

  function renderAll() {
    renderTop();
    renderRead();
    updatePlan(false);
    drawShots();
    renderLastShot();
    renderWhy();
    renderBottom();
    if (!S.setup) $("frames").innerHTML = "";
  }

  /* ---------- where the stream comes from ---------- */

  function setSource(text) {
    $("source").textContent = text;
    $("waiting-detail").textContent = text;
  }

  function parse(text) {
    var out = [];
    String(text).split("\n").forEach(function (row) {
      row = row.trim();
      if (!row) return;
      try { out.push(JSON.parse(row)); } catch (error) { /* skip a broken line */ }
    });
    return out;
  }

  function replay(file) {
    setSource("replay | " + file + " | loading");
    fetch(file).then(function (r) { return r.text(); }).then(function (text) {
      var lines = parse(text);
      var i = 0;
      var offset = isNaN(AT) ? 0 : AT;
      while (i < lines.length && lines[i].t <= offset) handle(lines[i++]);
      if (HOLD) { setSource("replay | " + file + " | held at " + offset + " s"); return; }
      var start = performance.now();
      setSource("replay | " + file + " | " + SPEED + "x");
      (function tick() {
        var now = offset + (performance.now() - start) / 1000 * SPEED;
        while (i < lines.length && lines[i].t <= now) handle(lines[i++]);
        if (i < lines.length) setTimeout(tick, 30);
        else setSource("replay | " + file + " | finished");
      })();
    }).catch(function () {
      setSource("replay | " + file + " | could not load");
    });
  }

  var attempts = 0;

  function connect() {
    var socket;
    var fresh_connection = true;
    setSource("connecting | " + WS_URL);
    try { socket = new WebSocket(WS_URL); } catch (error) { again(); return; }

    socket.onopen = function () {
      attempts = 0;
      setSource("live | " + WS_URL);
    };
    socket.onmessage = function (event) {
      if (typeof event.data !== "string") return;
      parse(event.data).forEach(function (line) {
        /* The server replays the match so far on connect, so start clean. */
        if (fresh_connection) {
          fresh_connection = false;
          if (!(line.message && line.message.type === "setup") && S.setup) {
            var keep = S.setup;
            onSetup(keep);
          }
        }
        handle(line);
      });
    };
    socket.onerror = function () { try { socket.close(); } catch (error) { /* closing anyway */ } };
    socket.onclose = again;
  }

  var waiting_to_retry = false;

  function again() {
    if (waiting_to_retry) return;
    waiting_to_retry = true;
    attempts += 1;
    setSource("reconnecting | " + WS_URL);
    setTimeout(function () { waiting_to_retry = false; connect(); }, Math.min(3000, 400 * attempts));
  }

  if (params.get("still") === "1") document.body.classList.add("still");
  renderAll();
  setInterval(function () { if (S.adapter.open) renderTop(); }, 250);

  if (REPLAY) replay(REPLAY);
  else connect();
})();
