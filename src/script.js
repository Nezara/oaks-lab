"use strict";
/* ============================================================================
   Oak's Lab scripts — the node editor, the graph-to-rows compiler, and the
   dry run.

   A gen1recomp script is an array of rows, `{ "verb", arg1, ... }`, with
   `label` rows as jump targets. That is already a graph written down, so the
   node editor is a serialiser rather than a code generator: every node is one
   row, every edge is fall-through or a jump, and the mapping runs both ways.
   ========================================================================== */

const CMD = PACK.commands;
const isCheck = (verb) => !!CMD[verb]?.check;

/* ------------------------------------------------------ Oak's Lab blocks -- */

/**
 * One block the engine has no verb for: the Pokemon a battle uses. A
 * trainer's party is species and level, full stop -- neither the `trainers`
 * registry nor `give_pokemon` has a moves field anywhere, because the engine
 * always derives a Pokemon's battle moves from that species' own learnset at
 * that level. A mod cannot set a custom moveset per trainer -- only per
 * species, by editing the species.
 *
 * It holds its six rows as `args.mons` -- a small table, not six separate
 * connectable blocks -- so building a team is filling in a grid, not placing
 * and wiring six little nodes. `mf: true` marks it so the compiler and
 * inspector special-case it; `summarise` lists the filled rows instead of the
 * generic arg-joining, and `ports` removes the default single "then" exit,
 * since nothing follows a team -- it is pointed at, not run.
 */
const MF_VERBS = {
  __team: {
    verb: "__team", category: "Battles and mons", label: "Pokemon team",
    does: "the Pokemon a battle uses -- up to six, species and level each. Connect this to a "
      + "“Start a battle” block's team arrow.",
    check: false, starter: true, mf: true, args: [], defaults: { mons: [] },
    summarise: (n) => {
      const mons = (n.args?.mons || []).filter((m) => m.species);
      return mons.length ? mons.map((m) => `${m.species} lv${m.level || 5}`).join("\n") : "empty";
    },
    ports: () => [],
  },
};
Object.assign(CMD, MF_VERBS);

// The Pokemon-team block's six rows, drawn straight onto its node box (see
// renderNodes) instead of only in the side inspector -- always six rows, a
// species picker and a level box each. A blank species means "unused";
// syncBattleTeams skips it. The level box updates the model on every
// keystroke but only redraws the graph on change/blur -- redrawing on
// oninput would tear out the very input the user is typing into.
function teamRows(n, surface) {
  const args = (n.args ||= { mons: [] });
  const mons = (args.mons ||= []);
  while (mons.length < 6) mons.push({ species: "", level: 5 });
  mons.length = 6;

  const table = el("div", { class: "monTable monTable-node" });
  mons.forEach((mon) => {
    table.append(
      refSelect("pokemon", () => mon.species, (v) => {
        mon.species = v; touch(); renderNodes(surface); refreshNodeEditors();
      }, { blank: "—", noFilter: true }),
      el("input", {
        type: "number", min: 1, max: 100, value: mon.level || 5,
        oninput: (e) => { mon.level = +e.target.value || 1; touch(); },
        onchange: () => { renderNodes(surface); refreshNodeEditors(); },
      }));
  });
  return table;
}

// start_battle gains a graph-only "team" exit for a trainer battle, pointing
// it at a Pokemon-team block so a party can live as nodes instead of only as
// a trainers-registry id typed into "who". This is additive to the real
// engine verb -- picking a trainer directly in the "who" field, with no team
// connected, still works and still ships exactly the same row.
if (CMD.start_battle) {
  const whoArg = CMD.start_battle.args.find((a) => a.name === "who");
  if (whoArg) whoArg.type = { kind: "ref", registry: "trainers" };
  // The team exit reads left-to-right rather than top-to-bottom -- a
  // trainer and its party sit side by side, not stacked -- so it is drawn
  // on the block's right edge (`side: "right"`) instead of the bottom row.
  CMD.start_battle.ports = (n) => (n.args?.kind === "trainer"
    ? [{ key: "next", label: "then ▸", cls: "" }, { key: "team", label: "team", cls: "team", side: "right" }]
    : [{ key: "next", label: "then ▸", cls: "" }]);
}

/**
 * A block's exits, as {key, label, cls}. `key` is the property on the node
 * that holds the target uid, so ports are just named edges -- `next` and `no`
 * are two of them rather than the only two.
 */
function portsOf(n) {
  const spec = CMD[n?.verb];
  if (spec?.ports) return spec.ports(n);
  if (isCheck(n?.verb)) {
    return [{ key: "next", label: "YES ▸", cls: "yes" }, { key: "no", label: "NO ▸", cls: "no" }];
  }
  return [{ key: "next", label: "then ▸", cls: "" }];
}

// A node's drawn height, needed to start wires at the right place now that a
// block can carry four stacked exits instead of one row of them.
function nodeH(n) {
  const ports = portsOf(n).length;
  return NODE_H + (ports > 2 ? (ports - 1) * 26 : 0);
}

// Filled in by npc.js -- the inspector body for a block whose settings are not
// a flat list of typed args. Keyed by verb.
const NODE_EDITORS = {};

// The node editor is drawn twice: full-size on the Scripts tab, and again
// embedded in the Content tab's NPC view. Both draw the same global
// P.sel.script / P.sel.node into different DOM ids, so every render/wiring
// function below takes a "surface" telling it which ids to use.
const SCRIPT_SURFACE = { stage: "nodeStage", wires: "wires", inspector: "nodeInspector", palette: "verbPalette", allVerbs: "allVerbs" };
const NPC_SURFACE = { stage: "npcNodeStage", wires: "npcWires", inspector: "npcNodeInspector", palette: "npcVerbPalette", allVerbs: "npcAllVerbs" };

function newScript(name, mapId, kind) {
  const startUid = uid();
  return {
    uid: uid(),
    name,
    mapId: mapId || "",
    kind: kind || "talk",
    textKey: "TEXT_" + (name || "script").toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    start: startUid,
    nodes: [{ uid: startUid, verb: "show_text", args: { textId: "Hello!" }, x: 40, y: 40, next: null, no: null }],
  };
}

const curScript = () => P.scripts.find((s) => s.uid === P.sel.script) || null;
const nodeById = (s, id) => s.nodes.find((n) => n.uid === id) || null;

/* ------------------------------------------------------------- compiler -- */

/**
 * Walk the graph from `start` and emit script rows.
 *
 * Labels are minted only where they are needed — a node with more than one
 * way in, or the false side of a branch — so a straight-line conversation
 * compiles to straight-line rows with no bookkeeping noise in it.
 */
function compileScript(src) {
  const errors = [];
  // A Pokemon team connected to a "Start a battle" block is graph state, not
  // rows -- fold it into the trainers registry and that block's own who/party
  // args before anything below reads them.
  if (typeof syncBattleTeams === "function") syncBattleTeams(src);
  const s = src;
  const byId = new Map(s.nodes.map((n) => [n.uid, n]));
  const start = byId.get(s.start);
  if (!start) return { rows: [], errors: ["no starting block"], unreached: s.nodes.map((n) => n.uid), labels: new Map() };

  // reachability + in-degree, over reachable edges only
  const reached = new Set();
  const inDeg = new Map();
  const isFalseTarget = new Set();
  const walk = [start.uid];
  while (walk.length) {
    const id = walk.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    const n = byId.get(id);
    if (!n) continue;
    const outs = portsOf(n).map((p) => n[p.key]);
    if (isCheck(n.verb) && n.no) isFalseTarget.add(n.no);
    for (const t of outs) {
      if (!t) continue;
      if (!byId.has(t)) { errors.push(`a block points at something that no longer exists`); continue; }
      inDeg.set(t, (inDeg.get(t) || 0) + 1);
      walk.push(t);
    }
  }

  const needsLabel = (id) => (inDeg.get(id) || 0) > 1 || isFalseTarget.has(id);

  const labels = new Map();
  const used = new Set(["end"]);
  const labelOf = (id) => {
    if (labels.has(id)) return labels.get(id);
    const n = byId.get(id);
    // A label the author named beats a generated one; otherwise say what the
    // label is FOR, since "otherwise:" reads better in Lua than "show_text:".
    const base = (n?.label
      ? n.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
      : isFalseTarget.has(id) ? "otherwise" : "join") || "step";
    let name = base, i = 2;
    while (used.has(name)) name = base + "_" + i++;
    used.add(name);
    labels.set(id, name);
    return name;
  };
  // Mint every needed label up front so a forward jump never invents a name
  // that a later block then renames. The start node needs one as soon as
  // anything loops back to it -- it is the one node that can be jumped to
  // without having more than one way in.
  for (const id of reached) if (needsLabel(id)) labelOf(id);
  if ((inDeg.get(start.uid) || 0) >= 1) labelOf(start.uid);

  const rowFor = (n) => {
    const spec = CMD[n.verb];
    if (!spec) { errors.push(`unknown verb "${n.verb}"`); return [n.verb]; }
    // Team and Pokemon blocks are data a "Start a battle" block reads via
    // syncBattleTeams, not rows of their own.
    if (spec.mf) return null;
    const args = spec.args.map((a) => {
      const v = n.args?.[a.name];
      return v === undefined || v === "" ? (a.default !== undefined ? a.default : null) : v;
    });
    while (args.length && (args[args.length - 1] === null || args[args.length - 1] === undefined)) args.pop();
    return [n.verb, ...args.map((a) => (a === null ? false : a))];
  };

  const emitted = new Set();
  const blocks = [];
  const queue = [start.uid];

  while (queue.length) {
    const head = queue.shift();
    if (emitted.has(head)) continue;

    const block = { rows: [], terminated: false };
    if (labels.has(head)) block.rows.push(["label", labels.get(head)]);

    let cur = head;
    while (cur) {
      const n = byId.get(cur);
      if (!n) break;
      emitted.add(cur);
      const row = rowFor(n);
      if (row) block.rows.push(row);

      let next = n.next;
      if (isCheck(n.verb)) {
        if (n.no) {
          block.rows.push(["jump_if_false", labelOf(n.no)]);
          queue.push(n.no);
        } else {
          block.rows.push(["jump_if_false", "end"]);
        }
      }

      if (!next) break;
      if (emitted.has(next)) {
        block.rows.push(["jump", labelOf(next)]);
        block.terminated = true;
        break;
      }
      // A join point keeps its label but can still be emitted inline.
      if (labels.has(next)) block.rows.push(["label", labels.get(next)]);
      cur = next;
    }
    blocks.push(block);
  }

  // A block that simply runs out must not fall into the next block's label.
  const rows = [];
  blocks.forEach((b, i) => {
    rows.push(...b.rows);
    if (!b.terminated && i < blocks.length - 1) rows.push(["jump", "end"]);
  });

  const unreached = s.nodes.filter((n) => !reached.has(n.uid)).map((n) => n.uid);
  return { rows, errors, unreached, labels, reached };
}

/* ---------------------------------------------------------- node canvas -- */

let armed = null;             // { from: uid, port: "next" | "no" }
const NODE_W = 190, NODE_H = 74, TEAM_W = 226;

function renderNodes(surface = SCRIPT_SURFACE) {
  const stage = $("#" + surface.stage);
  const svg = $("#" + surface.wires);
  if (!stage) return;
  $$(".node", stage).forEach((n) => n.remove());
  svg.textContent = "";

  const s = curScript();
  if (!s) { stage.style.width = stage.style.height = ""; return; }

  const info = compileScript(s);
  const unreached = new Set(info.unreached);

  let maxX = 0, maxY = 0;
  const elByUid = new Map();
  for (const n of s.nodes) {
    const spec = CMD[n.verb] || { label: n.verb, args: [] };
    const summary = spec.summarise ? spec.summarise(n) : spec.args
      .map((a) => n.args?.[a.name])
      .filter((v) => v !== undefined && v !== "")
      .join("  ");

    // A `side` port (the team exit) is drawn on the block's own edge, not in
    // the bottom row with the rest -- see sockButton and the CSS for .side.
    const ports = portsOf(n);
    const bottomPorts = ports.filter((p) => !p.side);

    const div = el("div", {
      class: "node"
        + (n.uid === s.start ? " start" : "")
        + (spec.mf ? " klass" : "")
        + (isCheck(n.verb) ? " check" : "")
        + (n.uid === P.sel.node ? " sel" : "")
        + (unreached.has(n.uid) ? " unreached" : "")
        + (ports.length > bottomPorts.length ? " has-side" : ""),
      style: `left:${n.x}px;top:${n.y}px`,
      "data-uid": n.uid,
    });
    div.append(el("div", { class: "nt" }, (n.uid === s.start ? "▶ " : "") + spec.label));
    // The Pokemon team block edits its six rows right here on the canvas --
    // it is the whole point of the block, so there is nothing to gain by
    // sending the user to the side inspector to fill in a table they could
    // just as well fill in on the shape they're already looking at.
    if (n.verb === "__team") div.append(teamRows(n, surface));
    else div.append(el("div", { class: "na" }, summary || "—"));

    const socks = el("div", { class: "socks" + (bottomPorts.length > 2 ? " many" : "") });
    for (const p of bottomPorts) socks.append(sockButton(n, p.key, p.label, p.cls));
    div.append(socks);
    for (const p of ports) if (p.side) div.append(sockButton(n, p.key, p.label, p.cls, p.side));
    stage.append(div);
    elByUid.set(n.uid, div);

    maxX = Math.max(maxX, n.x + (n.verb === "__team" ? TEAM_W : NODE_W));
    maxY = Math.max(maxY, n.y + nodeH(n) + 46);
  }

  stage.style.width = (maxX + 60) + "px";
  stage.style.height = (maxY + 60) + "px";
  svg.setAttribute("viewBox", `0 0 ${maxX + 60} ${maxY + 60}`);
  svg.setAttribute("width", maxX + 60);
  svg.setAttribute("height", maxY + 60);

  // Wires are drawn from where each socket button actually landed, not a
  // guess at it -- a stacked ("many") layout puts its exits one per row, not
  // spread evenly along the bottom, and a two-exit row's buttons are rarely
  // the same width. Measuring is what makes a red wire start at the red dot
  // it belongs to instead of somewhere near it.
  const stageRect = stage.getBoundingClientRect();
  for (const n of s.nodes) {
    const fromEl = elByUid.get(n.uid);
    for (const p of portsOf(n)) {
      const toEl = n[p.key] ? elByUid.get(n[p.key]) : null;
      if (!toEl) continue;
      const sockEl = fromEl.querySelector(`.sock[data-sock="${p.key}"]`);
      if (!sockEl) continue;
      const sr = sockEl.getBoundingClientRect(), tr = toEl.getBoundingClientRect();
      // A side port leaves from its edge (right or left) toward the middle
      // of whatever it points at, instead of top-to-bottom like every other
      // wire -- the vertical curve math below would loop back on itself for
      // two blocks sitting side by side rather than stacked.
      const x1 = p.side === "right" ? sr.right - stageRect.left
        : p.side === "left" ? sr.left - stageRect.left
        : sr.left + sr.width / 2 - stageRect.left;
      const y1 = p.side ? sr.top + sr.height / 2 - stageRect.top : sr.bottom - stageRect.top;
      const x2 = p.side === "right" ? tr.left - stageRect.left
        : p.side === "left" ? tr.right - stageRect.left
        : tr.left + tr.width / 2 - stageRect.left;
      const y2 = p.side ? tr.top + tr.height / 2 - stageRect.top : tr.top - stageRect.top;
      wire(svg, x1, y1, x2, y2, p.cls, !!p.side);
    }
  }
}

function sockButton(n, port, text, cls, side) {
  return el("div", {
    class: "sock " + cls + (side ? ` side side-${side}` : "")
      + (armed && armed.from === n.uid && armed.port === port ? " arm" : ""),
    "data-sock": port, "data-uid": n.uid,
    title: n[port] ? "connected — tap to re-point" : "tap, then tap the next block",
  }, n[port] ? text.replace("▸", "•") : text);
}

// Endpoints are measured DOM positions (see renderNodes), not derived from
// node coordinates -- that is what keeps a wire glued to the socket it left,
// however many exits a block has or however they are laid out. `horiz`
// curves the wire left-to-right instead of top-to-bottom, for a side port.
function wire(svg, x1, y1, x2, y2, cls, horiz) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  let d;
  if (horiz) {
    const dx = Math.max(24, Math.abs(x2 - x1) / 2);
    d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  } else {
    const dy = Math.max(24, Math.abs(y2 - y1) / 2);
    d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }
  path.setAttribute("d", d);
  path.setAttribute("class", "wire " + cls);
  svg.append(path);
}

/* ------------------------------------------------------- canvas gestures -- */

function wireCanvas(surface = SCRIPT_SURFACE) {
  const stage = $("#" + surface.stage);
  if (!stage) return;
  let drag = null;

  // Delete needs somewhere to point a keydown listener at. The stage itself
  // is that place: it takes focus on interaction, so the same key does the
  // right thing on whichever of the two node editors (Scripts tab, or the
  // one docked in the NPC workspace) the user was last clicked into.
  stage.tabIndex = 0;

  stage.addEventListener("pointerdown", (ev) => {
    const s = curScript();
    if (!s) return;
    stage.focus();

    const sock = ev.target.closest(".sock");
    if (sock) {
      ev.preventDefault();
      const from = sock.dataset.uid, port = sock.dataset.sock;
      if (armed && armed.from === from && armed.port === port) armed = null;   // tap again to cancel
      else armed = { from, port };
      renderNodes(surface);
      return;
    }

    const nodeEl = ev.target.closest(".node");
    if (!nodeEl) { if (armed) { armed = null; renderNodes(surface); } return; }
    const id = nodeEl.dataset.uid;

    if (armed) {
      if (armed.from !== id) {
        const from = nodeById(s, armed.from);
        from[armed.port] = id;
        touch();
      }
      armed = null;
      P.sel.node = id;
      renderNodes(surface);
      renderInspector(surface);
      return;
    }

    // A tap that landed on a field the block draws inline (the Pokemon-team
    // rows) is that field's click, not a drag -- starting a drag here would
    // capture the pointer away from the <select>/<input> and stop it opening
    // or focusing, and redrawing the node graph mid-interaction would tear
    // the very control the user just touched out from under them.
    if (ev.target.closest("select, input, textarea, option")) { P.sel.node = id; return; }

    P.sel.node = id;
    const n = nodeById(s, id);
    drag = { id, dx: ev.clientX - n.x, dy: ev.clientY - n.y, moved: false };
    nodeEl.setPointerCapture(ev.pointerId);
    renderNodes(surface);
    renderInspector(surface);
  });

  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const s = curScript();
    const n = nodeById(s, drag.id);
    n.x = Math.max(0, Math.round(ev.clientX - drag.dx));
    n.y = Math.max(0, Math.round(ev.clientY - drag.dy));
    drag.moved = true;
    const div = $(`.node[data-uid="${drag.id}"]`, stage);
    if (div) { div.style.left = n.x + "px"; div.style.top = n.y + "px"; }
  });

  const endDrag = () => {
    if (!drag) return;
    if (drag.moved) { touch(); renderNodes(surface); }
    drag = null;
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  // Right-click empty canvas: search every verb by name or category and drop
  // it exactly where the pointer is. The left palette stays the few starter
  // blocks; this is how the rest of the 65 get reached without a click-heavy
  // "show everything" list crowding out the common ones.
  stage.addEventListener("contextmenu", (ev) => {
    if (!curScript() || ev.target.closest(".node")) return;
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    openNodeMenu(surface, ev.clientX, ev.clientY, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
  });

  stage.addEventListener("keydown", (ev) => {
    if (ev.key !== "Delete" && ev.key !== "Backspace") return;
    if (ev.target !== stage) return;             // typing in a field, not the canvas itself
    if (!P.sel.node) return;
    ev.preventDefault();
    deleteNode(P.sel.node, surface);
  });
}

/* --------------------------------------------------- right-click search -- */

let nodeMenuEl = null;

function closeNodeMenu() {
  nodeMenuEl?.remove();
  nodeMenuEl = null;
  document.removeEventListener("pointerdown", onNodeMenuOutsideClick, true);
  document.removeEventListener("keydown", onNodeMenuKey, true);
}
function onNodeMenuOutsideClick(ev) {
  if (nodeMenuEl && !nodeMenuEl.contains(ev.target)) closeNodeMenu();
}
function onNodeMenuKey(ev) {
  if (ev.key === "Escape") closeNodeMenu();
}

function openNodeMenu(surface, clientX, clientY, at) {
  closeNodeMenu();

  const all = Object.values(CMD).filter((c) => c.verb !== "label" && !c.verb.startsWith("jump"));
  const menu = el("div", { class: "nodemenu" });
  const search = el("input", { type: "search", placeholder: `search ${all.length} blocks…`, autofocus: true });
  const list = el("div", { class: "nodemenu-list" });
  menu.append(search, list);

  const fill = (needle) => {
    list.textContent = "";
    const q = needle.trim().toLowerCase();
    const groups = {};
    for (const c of all) {
      if (q && !c.label.toLowerCase().includes(q) && !c.category.toLowerCase().includes(q) && !c.verb.includes(q)) continue;
      (groups[c.category] ||= []).push(c);
    }
    const cats = Object.keys(groups);
    if (!cats.length) { list.append(el("div", { class: "empty" }, "nothing matches")); return; }
    for (const cat of cats) {
      const d = el("details", { class: "palette-group", open: true }, el("summary", {}, cat));
      for (const c of groups[cat].sort((a, b) => a.label.localeCompare(b.label))) {
        d.append(el("button", {
          class: "verb", title: c.does.replace(/`/g, ""),
          onclick: () => { closeNodeMenu(); addNode(c.verb, surface, at); },
        }, c.label));
      }
      list.append(d);
    }
  };
  fill("");
  search.addEventListener("input", (e) => fill(e.target.value));
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNodeMenu(); });

  document.body.append(menu);
  // Clamp inside the viewport rather than letting a corner click push the
  // menu half off-screen.
  const w = menu.offsetWidth || 240, h = menu.offsetHeight || 320;
  menu.style.left = Math.min(clientX, innerWidth - w - 8) + "px";
  menu.style.top = Math.min(clientY, innerHeight - h - 8) + "px";
  nodeMenuEl = menu;
  search.focus();

  setTimeout(() => {
    document.addEventListener("pointerdown", onNodeMenuOutsideClick, true);
    document.addEventListener("keydown", onNodeMenuKey, true);
  }, 0);
}

/* ------------------------------------------------------------- palette -- */

function renderPalette(surface = SCRIPT_SURFACE) {
  const host = $("#" + surface.palette);
  if (!host) return;
  host.textContent = "";
  const all = $("#" + surface.allVerbs)?.checked;
  const countEl = surface === SCRIPT_SURFACE ? $("#verbCount") : null;
  if (countEl) countEl.textContent = Object.keys(CMD).length;

  const groups = {};
  for (const c of Object.values(CMD)) {
    if (!all && !c.starter) continue;
    if (c.verb === "label" || c.verb.startsWith("jump")) continue;   // edges, not blocks
    (groups[c.category] ||= []).push(c);
  }

  for (const [cat, list] of Object.entries(groups)) {
    const d = el("details", { class: "palette-group", open: true }, el("summary", {}, cat));
    for (const c of list.sort((a, b) => a.label.localeCompare(b.label))) {
      d.append(el("button", {
        class: "verb", title: c.does.replace(/`/g, ""),
        onclick: () => addNode(c.verb, surface),
      }, c.label, all ? el("small", {}, c.verb) : null));
    }
    host.append(d);
  }
}

/**
 * `at`, when given, is an explicit stage-local position -- a right-click on
 * empty canvas placing a block exactly where the user pointed. Without it,
 * the block chains onto the selected node's free exit and drops just below
 * it, the way the left palette has always behaved.
 */
function addNode(verb, surface = SCRIPT_SURFACE, at = null) {
  const s = curScript();
  if (!s) { toast("Make a script first", true); return; }
  const spec = CMD[verb];
  // A block's own defaults win over per-arg ones: the Oak's Lab blocks keep
  // their state outside `args` specs entirely, so they declare it here.
  const args = { ...(spec.defaults || {}) };
  for (const a of spec.args) if (a.default !== undefined) args[a.name] = a.default;
  // A trainer battle is the one kind the team arrow applies to, and pairing
  // it with a team block (below) is the whole point of dropping this one --
  // defaulting to it means that block actually has a port to plug into
  // instead of sitting there unreached with the arrow nowhere to be seen.
  if (verb === "start_battle") args.kind = "trainer";

  const sel = !at && P.sel.node ? nodeById(s, P.sel.node) : null;
  const n = {
    uid: uid(), verb, args, next: null, no: null,
    x: at ? Math.round(at.x - NODE_W / 2) : sel ? sel.x : 40,
    y: at ? Math.round(at.y) : sel ? sel.y + 120 : 40 + s.nodes.length * 30,
  };
  s.nodes.push(n);
  // Adding a block while one is selected chains onto it if its exit is free.
  if (sel && !sel.next) sel.next = n.uid;

  // A trainer's party is data a battle block reads, not a step of its own,
  // so the team block that comes with a new "Start a battle" skips the
  // chain-onto-the-selection dance above entirely -- it is wired straight
  // onto this node's team arrow and left unselected, out of the way of
  // whatever the user places next.
  if (verb === "start_battle") {
    const team = newTeamNode(n.x + 260, n.y, []);
    s.nodes.push(team);
    n.team = team.uid;
  }

  P.sel.node = n.uid;
  touch();
  renderNodes(surface);
  renderInspector(surface);
}

/* ----------------------------------------------------------- inspector -- */

// `opts` is threaded through to the node's own custom editor (NODE_EDITORS)
// and back into deleteNode() so a re-render after deleting a block keeps
// whatever this call was invoked with.
function renderInspector(surface = SCRIPT_SURFACE, opts = {}) {
  const host = $("#" + surface.inspector);
  if (!host) return;
  host.textContent = "";
  const s = curScript();
  if (!s) { host.append(el("div", { class: "empty" }, "Make a script first.")); return; }

  const n = P.sel.node ? nodeById(s, P.sel.node) : null;
  if (!n) { host.append(el("div", { class: "empty" }, "Select a block to edit it.")); return; }
  const spec = CMD[n.verb] || { label: n.verb, args: [], does: "" };

  host.append(el("h2", {}, "Block"));
  host.append(el("div", { class: "row" },
    el("strong", { style: "color:var(--accent);flex:1" }, spec.label),
    el("span", { class: "tag" }, n.verb)));
  if (spec.does) host.append(el("p", { class: "hint" }, spec.does.replace(/`/g, "")));

  // Only matters when something jumps here, so it stays out of the way.
  if ((compileScript(s).labels || new Map()).has(n.uid)) {
    host.append(labelledInput("Branch name", n.label || "", (v) => { n.label = v; renderNodes(surface); }));
  }

  // Blocks whose settings are not a flat list of typed args bring their own
  // editor -- the class block's trainer and party picker, for one.
  const custom = NODE_EDITORS[n.verb];
  if (custom) {
    custom(host, n, surface, opts);
  } else {
    if (!spec.args.length) host.append(el("p", { class: "hint" }, "No settings."));
    for (const a of spec.args) {
      renderField(host, a.name, a.type,
        () => n.args?.[a.name] ?? a.default ?? "",
        (v) => { (n.args ||= {})[a.name] = v; renderNodes(surface); },
        { label: a.label || a.name, onChange: () => renderNodes(surface), rerender: () => renderInspector(surface, opts) });
    }
  }

  const exits = portsOf(n);
  if (exits.length) {
    host.append(el("h2", {}, "Goes to"));
    for (const p of exits) {
      const target = n[p.key] ? nodeById(s, n[p.key]) : null;
      host.append(el("div", { class: "row", style: "margin-bottom:4px" },
        el("span", { style: "flex:0 0 72px;color:var(--dim);font-size:11px" }, p.label.replace(" ▸", "")),
        el("span", { style: "flex:1;font-size:11px" },
          target ? (CMD[target.verb]?.label || target.verb) : "— nothing —"),
        target ? el("button", { class: "fixed danger", style: "min-height:26px;padding:0 8px",
          onclick: () => { n[p.key] = null; touch(); renderNodes(surface); renderInspector(surface, opts); } }, "×") : null));
    }
  }

  host.append(el("h2", {}, "This block"));
  // Any ordinary block can be where a script begins -- an imported trainer's
  // own graph starts on "Is flag set?", not "Say something", and there is
  // nothing special about the first node a fresh script happens to get.
  // The one real exception is a data block like Pokemon team: it has no
  // exit to fall through to (ports: () => []) and compiles to no row at
  // all (rowFor skips anything with mf: true), so starting there would
  // compile to an empty script with nothing said about why.
  const cantStart = !!spec.mf;
  host.append(el("div", { class: "row" },
    el("button", {
      disabled: cantStart, title: cantStart ? "This block is data another block reads, not a step that runs." : "",
      onclick: () => { s.start = n.uid; touch(); renderNodes(surface); toast("Starts here now"); },
    }, "Start here"),
    el("button", { class: "danger", onclick: () => deleteNode(n.uid, surface, opts) }, "Delete")));

  host.append(el("h2", {}, "Rows this makes"));
  const info = compileScript(s);
  host.append(el("pre", { class: "code", style: "max-height:200px" },
    info.rows.map((r) => "{ " + r.map((a) => (typeof a === "string" ? '"' + a.replace(/\n/g, "\\n") + '"' : String(a))).join(", ") + " },").join("\n") || "-- empty"));
  for (const e of info.errors) host.append(el("p", { class: "hint bad" }, e));
}

// A labelled field. Given a registry, it becomes a dropdown of that
// registry's ids rather than a box you have to know the answer to type into.
function labelledInput(label, value, onInput, refRegistry) {
  const wrap = el("div", {});
  wrap.append(el("label", {}, label));
  if (refRegistry) {
    let cur = value || "";
    wrap.append(refSelect(refRegistry, () => cur, (v) => { cur = v; onInput(v); }));
  } else {
    wrap.append(el("input", {
      value: value || "",
      oninput: (e) => { onInput(e.target.value); touch(); },
    }));
  }
  return wrap;
}

function deleteNode(id, surface = SCRIPT_SURFACE, opts = {}) {
  const s = curScript();
  if (s.nodes.length === 1) { toast("A script needs at least one block", true); return; }
  s.nodes = s.nodes.filter((n) => n.uid !== id);
  for (const n of s.nodes) {
    for (const p of portsOf(n)) if (n[p.key] === id) n[p.key] = null;
  }
  if (s.start === id) s.start = s.nodes[0].uid;
  P.sel.node = null;
  touch();
  renderNodes(surface);
  renderInspector(surface, opts);
}

function renderScriptTab() {
  renderScriptFiles();
}
