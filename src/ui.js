"use strict";
/* ============================================================================
   Oak's Lab UI — tabs, the Start guide, the Content tab and the Export tab.
   ========================================================================== */

/* ----------------------------------------------------------------- tabs -- */

function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  if (name === "content") renderContentTab();
  if (name === "script") renderScriptTab();
  if (name === "export") renderExportTab();
  if (name === "start") renderStartTab();
}

/* ---------------------------------------------------------------- start -- */

// One direct link per content workspace -- no wizard, no draft, no prefilled
// example. Building something now happens on the workspace itself, with
// New/Import/Copy right there at the top of it.
const EDITORS = [
  { title: "NPC Editor", blurb: "People: their sprite, where they stand, how they move, what they say.", sub: "npc" },
  { title: "Pokemon Editor", blurb: "Species: name, type, stats, moves, evolution, where it lives in the wild.", sub: "pokemon" },
  { title: "Move Editor", blurb: "Type, power, accuracy, PP, its animation and any status effect.", sub: "moves" },
  { title: "Item Editor", blurb: "What it does, what it costs, and where it turns up in the world.", sub: "items" },
  { title: "Map Editor", blurb: "Paint blocks, place warps and signs, patch a vanilla map or build one from scratch.", sub: "maps" },
];

// Not wired up to anything yet -- shown so the shape of where this tool is
// going is visible without pretending either already works. `go` is kept
// (rather than deleted) so turning one on later is just adding an onclick
// back to its card.
const TUTORIALS = [
  {
    title: "Rebalance something",
    blurb: "Change a Pokemon's stats, a move's power, an item's price. One line of Lua, no new content.",
    go() {
      P.entries.push({ uid: uid(), registry: "pokemon", verb: "patch", id: "GROWLITHE", data: { baseStats: { speed: 90 } } });
      P.sel.entry = P.entries[P.entries.length - 1].uid;
      touch();
      renderAll();
      showTab("content");
    },
  },
  {
    title: "Write a fetch quest",
    blurb: "A flag, an item, and two different things to say depending on whether the player has done the thing yet.",
    go() {
      const s = newScript("fetch quest", "", "talk");
      const chk  = s.nodes[0];
      chk.verb = "check_flag"; chk.args = { name: "MODFORGE_QUEST_DONE" };
      const done = { uid: uid(), verb: "show_text", args: { textId: "Thanks again!" }, x: 40, y: 160, next: null, no: null };
      const askQ = { uid: uid(), verb: "ask", args: { textId: "Bring me a\nPOTION?" }, x: 260, y: 160, next: null, no: null };
      const give = { uid: uid(), verb: "give_item", args: { itemId: "POTION", count: 1 }, x: 260, y: 280, next: null, no: null };
      const flag = { uid: uid(), verb: "set_flag", args: { name: "MODFORGE_QUEST_DONE" }, x: 260, y: 400, next: null, no: null };
      const nope = { uid: uid(), verb: "show_text", args: { textId: "Oh. Never mind." }, x: 480, y: 280, next: null, no: null };
      chk.next = done.uid; chk.no = askQ.uid;
      askQ.next = give.uid; askQ.no = nope.uid;
      give.next = flag.uid;
      s.nodes.push(done, askQ, give, flag, nope);
      P.scripts.push(s);
      P.sel.script = s.uid;
      touch();
      renderAll();
      showTab("script");
      toast("Fetch quest added — attach it to someone on the Scripts tab");
    },
  },
];

function renderEditorLinks() {
  const host = $("#recipes");
  host.textContent = "";
  for (const e of EDITORS) {
    host.append(el("div", { class: "card", onclick: () => { contentSub = e.sub; showTab("content"); } },
      el("h3", {}, e.title),
      el("p", {}, e.blurb)));
  }
}

function renderTutorials() {
  const host = $("#tutorials");
  if (!host) return;
  host.textContent = "";
  for (const t of TUTORIALS) {
    host.append(el("div", { class: "card soon" },
      el("span", { class: "soon-tag" }, "Coming soon"),
      el("h3", {}, t.title),
      el("p", {}, t.blurb)));
  }
}

function renderStartTab() {
  renderEditorLinks();
  renderTutorials();
}

/* -------------------------------------------------------------- content -- */

// Maps and scripts have their own tabs, so they are not offered here.
const HIDDEN_REGISTRIES = new Set(["maps", "map_scripts"]);

function addEntryDialog() {
  const body = el("div", {});
  let showAll = false;
  const state = { registry: "pokemon", verb: "patch", id: "" };

  const rebuild = () => {
    body.textContent = "";
    const list = (showAll ? Object.keys(PACK.registries) : PACK.starterRegistries)
      .filter((r) => !HIDDEN_REGISTRIES.has(r) && !PACK.registries[r]?.deprecated)
      .sort();
    if (!list.includes(state.registry)) state.registry = list[0];

    body.append(el("label", {}, "What kind of thing"));
    body.append(el("select", { onchange: (e) => { state.registry = e.target.value; rebuild(); } },
      ...list.map((r) => el("option", { value: r, selected: r === state.registry }, r))));
    body.append(el("label", {},
      el("input", { type: "checkbox", checked: showAll, onchange: (e) => { showAll = e.target.checked; rebuild(); } }),
      `Show all ${Object.keys(PACK.registries).length} registries`));

    const reg = PACK.registries[state.registry];
    body.append(el("p", { class: "hint" },
      `${reg.semantics} semantics → ${reg.target || "no Gen 1 home"}`));

    body.append(el("label", {}, "What to do with it"));
    const verbs = [
      ["patch", "patch — change a few fields, leave the rest"],
      ["register", "register — a brand new one"],
      ["override", "override — replace it entirely"],
      ["remove", "remove — delete it"],
    ];
    body.append(el("select", { onchange: (e) => { state.verb = e.target.value; state.id = ""; rebuild(); } },
      ...verbs.map(([v, t]) => el("option", { value: v, selected: v === state.verb }, t))));

    if (state.verb === "register") {
      body.append(el("label", {}, "Call it"));
      body.append(el("input", {
        value: state.id,
        placeholder: reg.example?.match(/:\w+\("([^"]+)"/)?.[1] || "SOME_ID",
        oninput: (e) => (state.id = idFromName(e.target.value)),
      }));
      body.append(el("p", { class: "hint" }, "A new id. Type a name — it gets tidied into the shape the engine wants."));
    } else {
      body.append(el("label", {}, "Which one"));
      body.append(refSelect(state.registry, () => state.id, (v) => (state.id = v),
        { blank: "— choose —" }));
    }

    if (reg.example) body.append(el("p", { class: "hint" }, "From the engine docs: " + reg.example));

    body.append(el("div", { class: "row", style: "margin-top:12px" },
      el("button", { class: "primary", onclick: () => {
        if (!state.id) { toast("Give it an id", true); return; }
        const data = {};
        if (state.verb === "register") {
          for (const f of reg.order) {
            const fd = reg.fields[f];
            if (fd.required && fd.type.kind !== "lua") data[f] = f === "id" ? state.id : defaultFor(fd.type);
          }
        }
        P.entries.push({ uid: uid(), registry: state.registry, verb: state.verb, id: state.id, data });
        P.sel.entry = P.entries[P.entries.length - 1].uid;
        touch();
        closeDialog();
        renderContentTab();
      } }, "Add it"),
      el("button", { onclick: closeDialog }, "Cancel")));
  };

  rebuild();
  dialog("Add a content record", body);
}

function renderEntryList() {
  const host = $("#entryList");
  host.textContent = "";
  if (!P.entries.length) { host.append(el("div", { class: "empty" }, "Nothing yet — press + Add, or pick a recipe on the Start tab.")); return; }
  for (const e of P.entries) {
    host.append(el("div", {
      class: "item" + (e.uid === P.sel.entry ? " sel" : ""),
      onclick: () => { P.sel.entry = e.uid; renderContentTab(); },
    },
      el("span", { class: "tag " + e.verb }, e.verb),
      el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" }, e.data?.name || e.id || "(no id)"),
      el("span", { class: "who" }, e.registry),
      el("button", {
        class: "x", title: "delete",
        onclick: (ev) => { ev.stopPropagation(); deleteEntry(e); },
      }, "✕")));
  }
}

function renderEntryForm() {
  const host = $("#entryForm");
  host.textContent = "";
  const e = P.entries.find((x) => x.uid === P.sel.entry);
  if (!e) { host.append(el("div", { class: "empty" }, "Add or select a content record.")); return; }
  const reg = PACK.registries[e.registry];

  host.append(el("h2", {}, e.registry + " · " + e.verb));
  if (e.verb === "register") {
    // A brand new id is not in any list, so this one stays a text box -- but
    // it still gets shaped for you rather than demanding the convention.
    host.append(labelledInput("Id", e.id, (v) => { e.id = idFromName(v); renderEntryList(); }));
  } else {
    host.append(labelledInput("Which one", e.id, (v) => { e.id = v; renderEntryList(); }, e.registry));
  }

  if (e.verb === "remove") {
    host.append(el("p", { class: "hint" }, "Nothing else to set — this deletes the record."));
  } else if (!reg.order.length) {
    host.append(el("p", { class: "hint" },
      "This registry takes a whole value rather than named fields: " + (reg.value || "any value")));
    renderField(host, "value", reg.valueType || { kind: "any" },
      () => e.data.__value, (v) => { e.data.__value = v; }, { label: "Value" });
  } else {
    e.data ||= {};
    const required = reg.order.filter((f) => reg.fields[f].required);
    const optional = reg.order.filter((f) => !reg.fields[f].required);

    if (required.length) host.append(el("h2", {}, e.verb === "register" ? "Required" : "Main fields"));
    for (const f of required) {
      renderField(host, f, reg.fields[f].type,
        () => e.data[f], (v) => { e.data[f] = v; },
        { required: true, rerender: renderEntryForm });
    }

    if (optional.length) {
      const det = el("details", {}, el("summary", { style: "cursor:pointer;color:var(--dim);font-size:11px;padding:8px 0" },
        `Optional fields (${optional.length})`));
      const inner = el("div", {});
      for (const f of optional) {
        renderField(inner, f, reg.fields[f].type,
          () => e.data[f], (v) => { e.data[f] = v; },
          { rerender: renderEntryForm });
      }
      det.append(inner);
      host.append(det);
    }
  }

  host.append(el("h2", {}, ""));
  host.append(el("button", { class: "danger", onclick: () => deleteEntry(e) }, "Delete this record"));
}

function renderEntryDoc() {
  const host = $("#entryDoc");
  host.textContent = "";
  const e = P.entries.find((x) => x.uid === P.sel.entry);
  if (!e) {
    host.append(el("h2", {}, "How this works"));
    host.append(el("p", { class: "hint" },
      "Every noun in the game is a record in one of " + Object.keys(PACK.registries).length +
      " registries. You register a new one, patch a few fields of an existing one, override it whole, or remove it. " +
      "Disabling your mod puts everything back."));
    return;
  }
  const reg = PACK.registries[e.registry];

  host.append(el("h2", {}, e.registry));
  host.append(el("p", { class: "hint" }, `Merge semantics: ${reg.semantics}. Writes to ${reg.target || "nothing on Gen 1"}.`));
  if (reg.deprecated) host.append(el("p", { class: "hint warn" }, "This registry is deprecated."));

  host.append(el("h2", {}, "The line this makes"));
  host.append(el("pre", { class: "code" },
    e.verb === "remove"
      ? `mod.content.${e.registry}:remove("${e.id}")`
      : `mod.content.${e.registry}:${e.verb}("${e.id}", { … })`));

  if (reg.example) {
    host.append(el("h2", {}, "From the engine docs"));
    host.append(el("pre", { class: "code" }, reg.example));
  }

  host.append(el("h2", {}, "Fields"));
  const t = el("div", {});
  for (const f of reg.order) {
    const fd = reg.fields[f];
    t.append(el("div", { style: "display:flex;gap:6px;font-size:11px;padding:2px 0" },
      el("span", { style: "color:var(--ink);flex:0 0 40%" }, f + (fd.required ? " *" : "")),
      el("span", { style: "color:var(--dimmer)" }, typeLabel(fd.type))));
  }
  host.append(t);
}

// The Content tab is now a strip of workspaces rather than one form. Only the
// visible one is drawn: the NPC workspace mounts a whole second node editor,
// and there is no reason to lay that out while somebody is on Items.
function renderContentTab() {
  showContentSub(contentSub);
}

/* --------------------------------------------------------------- export -- */

let previewFile = "main.lua";

function highlightLua(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // One pass over the source, rather than four passes over each other's
  // output.
  //
  // This was four chained .replace calls, and the second one matched inside
  // the markup the first had just written: every Lua comment came out as
  // <span class="<span class="k2">"k4"</span>">, because the tag the comment
  // rule emits contains a double-quoted "k4" and the string-literal rule
  // could not tell that apart from a string in the code. Matching every kind
  // of token in one alternation means nothing ever reads generated output,
  // and escaping per token rather than up front means the escapes cannot be
  // re-escaped either. The trailing [\s\S] is the catch-all: it takes one
  // character at a time so a token can never be entered halfway.
  return src.replace(
    /(--\[\[[\s\S]*?\]\]|--[^\n]*)|("(?:[^"\\]|\\.)*")|\b(return|function|end|local|true|false|nil)\b|\b(\d+)\b|([\s\S])/g,
    (m, comment, str, kw, num, other) => {
      if (comment) return '<span class="k4">' + esc(comment) + '</span>';
      if (str) return '<span class="k2">' + esc(str) + '</span>';
      if (kw) return '<span class="k1">' + kw + '</span>';
      if (num) return '<span class="k3">' + num + '</span>';
      return esc(other);
    });
}

// The Files heading that used to live on Export -- moved here wholesale, See
// the Lua and all, since main.lua is the one file someone tinkering by hand
// actually wants next to the block editor rather than off on another tab.
// Entirely optional reading: nothing here feeds back into P.
function renderScriptFiles() {
  const list = files();
  const host = $("#fileList");
  if (!host) return;
  host.textContent = "";
  for (const f of list) {
    host.append(el("div", {
      class: "item" + (f.name === previewFile ? " sel" : ""),
      onclick: () => { previewFile = f.name; renderScriptFiles(); },
    },
      el("span", { style: "flex:1" }, f.name),
      el("span", { class: "who" }, fileSize(f) + " B")));
  }

  const shown = list.find((f) => f.name === previewFile);
  const body = shown?.body ?? "";
  $("#filePreview").innerHTML = shown?.bytes
    ? `${shown.name} — ${shown.bytes.length} bytes of image data.\nIt ships in the zip as-is.`
    : previewFile.endsWith(".lua") ? highlightLua(body)
    : body.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function renderLint() {
  const host = $("#lintList");
  if (!host) return;
  host.textContent = "";
  const out = lint();
  if (!out.length) { host.append(el("div", { class: "hint good" }, "Nothing to fix.")); return; }
  for (const p of out) {
    host.append(el("div", { class: "hint " + (p.level === "bad" ? "bad" : "warn") },
      (p.level === "bad" ? "✕ " : "! ") + p.msg));
  }
}

/* --------------------------------------------------------------- export -- */

// Mod ids are lowercase snake_case (see the id regex in lint()), unlike a
// content record's ALL_CAPS -- so this is its own transform rather than a
// reuse of idFromName.
const modIdFromName = (name) =>
  String(name || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "my_mod";

function exportStep(host, n, title, note) {
  const wrap = el("div", { class: "step" });
  wrap.append(el("h3", {},
    el("span", { class: "n" }, n + "."),
    title,
    note ? el("span", { class: "said" }, note) : null));
  const body = el("div", { class: "body" });
  wrap.append(body);
  host.append(wrap);
  return body;
}

function exportStepName(host) {
  const body = exportStep(host, 1, "Mod name", P.meta.id || null);
  body.append(el("label", {}, "What's it called?"));
  const idLine = el("div", { class: "hint" });
  const showId = () => { idLine.textContent = P.meta.id ? `Folder and manifest id: ${P.meta.id}` : ""; };
  body.append(el("input", {
    value: P.meta.name || "", placeholder: "My First Mod",
    oninput: (e) => {
      P.meta.name = e.target.value;
      P.meta.id = modIdFromName(e.target.value);
      showId();
      touch();
    },
  }));
  showId();
  body.append(idLine);
}

function exportStepAuthor(host) {
  const body = exportStep(host, 2, "Author", P.meta.author || null);
  body.append(el("label", {}, "Who's making this?"));
  body.append(el("input", {
    value: P.meta.author || "", placeholder: "Your name",
    oninput: (e) => { P.meta.author = e.target.value; touch(); },
  }));
}

function exportStepVersion(host) {
  const body = exportStep(host, 3, "Version", P.meta.version || null);
  body.append(el("label", {}, "Version"));
  body.append(el("input", {
    value: P.meta.version || "", placeholder: "0.1.0",
    oninput: (e) => { P.meta.version = e.target.value; touch(); },
  }));
  body.append(el("p", { class: "hint" }, "semver — major.minor.patch, e.g. 0.1.0"));
}

function exportStepDescription(host) {
  const body = exportStep(host, 4, "Description", null);
  body.append(el("label", {}, "One line the mod manager shows"));
  body.append(el("input", {
    value: P.meta.description || "", placeholder: "What does your mod do?",
    oninput: (e) => { P.meta.description = e.target.value; touch(); },
  }));
}

function exportStepProblems(host) {
  const problems = lint();
  const note = problems.length ? `${problems.length} to fix` : "all clear";
  const body = exportStep(host, 5, "Problems", note);
  body.append(el("p", { class: "hint" + (problems.length ? " warn" : " good") },
    problems.length ? "Fix these before exporting — they'll likely break the mod in-game."
                     : "Nothing found. You're clear to export."));
  body.append(el("div", { id: "lintList" }));
}

function exportStepZip(host) {
  const list = files();
  const body = exportStep(host, 6, "Export", `${list.length} file${list.length === 1 ? "" : "s"}`);
  body.append(el("button", {
    class: "primary", style: "width:100%",
    onclick: () => {
      const problems = lint().filter((p) => p.level === "bad");
      if (problems.length && !confirm(problems.length + " problem(s) found. Download anyway?")) return;
      download(makeZip(files()), `${P.meta.id}-${P.meta.version}.zip`);
      toast("Downloaded " + P.meta.id + "-" + P.meta.version + ".zip");
    },
  }, "Download mod .zip"));
  body.append(el("p", { class: "hint" }, "What's inside:"));
  for (const f of list) {
    body.append(el("div", { class: "row", style: "color:var(--dim);font-size:14px;padding:2px 0" },
      el("span", { style: "flex:1" }, f.name),
      el("span", { class: "who" }, fileSize(f) + " B")));
  }
}

function exportStepGithub(host) {
  const body = exportStep(host, 7, "GitHub", "not yet");
  body.append(el("label", {}, "GitHub repo"));
  body.append(el("input", { value: P.meta.github || "", placeholder: "owner/repo", disabled: true }));
  body.append(el("p", { class: "hint" },
    "Auto-updates aren't wired up yet — not a feature Oak's Lab is adding right now."));
}

function renderExportTab() {
  const host = $("#exportSteps");
  host.textContent = "";
  exportStepName(host);
  exportStepAuthor(host);
  exportStepVersion(host);
  exportStepDescription(host);
  exportStepProblems(host);
  exportStepZip(host);
  exportStepGithub(host);
  renderLint();
}

/* ------------------------------------------------------------------ boot -- */

function renderAll() {
  applyCustomTilesets();
  renderStartTab();
  renderContentTab();
  renderScriptTab();
  renderMapTab();
  renderExportTab();
}

// A dead page with live-looking buttons is the worst failure mode there is,
// so anything that stops boot() says so on screen instead of in a console
// nobody has open -- least of all on a phone.
function fatal(title, detail, fix) {
  const banner = el("div", {
    style: "position:fixed;inset:0;z-index:999;background:var(--bg);color:var(--ink);"
      + "padding:24px;overflow:auto;font:13px/1.6 ui-monospace,monospace",
  },
    el("h2", { style: "color:var(--bad);border:0;font-size:15px;letter-spacing:0" }, title),
    el("p", { style: "color:var(--dim);max-width:60ch" }, detail),
    fix ? el("pre", { class: "code", style: "max-width:60ch" }, fix) : null,
    el("p", { style: "color:var(--dimmer);max-width:60ch" },
      "Oak's Lab needs no server and no internet — but it does need to be the built file."));
  document.body.append(banner);
}

const MAP_TOOL_HINT = {
  paint: "Drag to lay blocks down.",
  eyedrop: "Click a cell to pick up its block as the new brush, then switch straight to Paint.",
  select: "Drag to select an area of blocks. Drag inside the selection to move it.",
  solid: "Click a 16px cell to make it solid — the player can't walk there.",
  walk: "Click a 16px cell to open it up — the player can walk there even if the art says otherwise.",
  reset: "Click a 16px cell to clear its collision override — back to whatever the art itself says.",
  warp: "Click to drop a door.",
  warptile: "Click a 16px cell to mark its tile as a warp trigger — a warp only fires from a cell "
    + "whose tile is flagged this way, separately from placing the door itself.",
  sign: "Click to drop a sign.",
  npc: "Click to drop a person.",
  pick: "Click a door, sign or person to edit it, or drag it to move it.",
  remove: "Click a door, sign or person to delete it.",
};

// Shared by the toolbar's own click handler (in boot(), below) and the
// eyedropper (map.js's applyTool), which switches back to Paint on its own
// once it has picked something -- both need the exact same button/hint sync,
// not just a `mapTool = ...` assignment.
function selectMapTool(tool) {
  mapTool = tool;
  // Leaving Select behind shouldn't leave its marquee floating over
  // whatever tool comes next.
  if (mapTool !== "select") { selectRect = null; selectPreview = null; }
  $$("#mapTools button").forEach((x) => x.classList.toggle("on", x.dataset.tool === tool));
  const h = $("#mapToolHint");
  if (h) h.textContent = MAP_TOOL_HINT[mapTool] || "";
  renderMapCanvas();
}

function boot() {
  // The built page embeds its schema pack. src/app.html does not, and opening
  // that by mistake is the likeliest way to meet a page where nothing works.
  if (PACK_READ.unbuilt) {
    return fatal(
      "This is the source template, not the app.",
      "src/app.html still has its build placeholders in it, so there is no schema pack to drive the forms. "
      + "Build it once, then open oaks-lab.html (project root) — that file is standalone and works offline.",
      "node build.mjs");
  }
  if (PACK_READ.error || PACK_READ.missing) {
    return fatal("The schema pack did not load.",
      "The page is built but its embedded schema pack could not be read: " + (PACK_READ.error || PACK_READ.why),
      "node tools/build-schema-pack.mjs\nnode build.mjs");
  }

  load();

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) showTab(b.dataset.tab);
  });

  $("#btnSave").onclick = () => {
    save();
    download(new Blob([JSON.stringify(P, null, 1)], { type: "application/json" }), P.meta.id + ".modforge.json");
  };
  $("#btnOpen").onclick = () => $("#projectFile").click();
  $("#projectFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      P = Object.assign(BLANK(), JSON.parse(await f.text()));
      save(true);
      renderAll();
      toast("Opened " + f.name);
    } catch (err) { toast("Could not read that file", true); }
    e.target.value = "";
  };
  $("#btnNewProject").onclick = () => {
    if (!confirm("Throw away the current mod and start fresh?")) return;
    P = BLANK();
    save(true);
    renderAll();
    showTab("start");
  };

  $("#btnAddEntry").onclick = addEntryDialog;

  $("#contentSub").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) showContentSub(b.dataset.sub);
  });
  wireNpcDock();

  $("#btnAddMap").onclick = () => {
    const body = el("div", {});
    const state = {
      mode: "new", name: "My Cave", tileset: GAME ? Object.keys(GAME.tilesets)[0] : "CAVERN",
      base: "PALLET_TOWN", w: 6, h: 6, copyName: "Pallet Town copy",
    };
    const rebuild = () => {
      body.textContent = "";
      body.append(el("label", {}, "What are you making"));
      body.append(el("select", { onchange: (e) => { state.mode = e.target.value; rebuild(); } },
        el("option", { value: "new", selected: state.mode === "new" }, "a brand new map"),
        el("option", { value: "copy", selected: state.mode === "copy" }, "a copy of an existing map, under a new id"),
        el("option", { value: "patch", selected: state.mode === "patch" }, "changes to an existing map")));

      if (state.mode === "new") {
        const showId = el("p", { class: "hint" }, `The engine will know it as ${idFromName(state.name)}.`);
        body.append(el("label", {}, "Name"));
        body.append(el("input", { value: state.name, oninput: (e) => { state.name = e.target.value; showId.textContent = `The engine will know it as ${idFromName(state.name)}.`; } }));
        body.append(showId);
        body.append(el("label", {}, "Tileset"));
        body.append(el("select", { onchange: (e) => (state.tileset = e.target.value) },
          ...(GAME ? Object.keys(GAME.tilesets) : ["CAVERN"]).map((t) =>
            el("option", { value: t, selected: t === state.tileset }, t))));
        const g = el("div", { class: "grid2" });
        for (const d of ["w", "h"]) {
          g.append(el("div", {},
            el("label", {}, d === "w" ? "width (blocks)" : "height (blocks)"),
            el("input", { type: "number", min: 1, max: 60, value: state[d], oninput: (e) => (state[d] = +e.target.value) })));
        }
        body.append(g);
      } else if (state.mode === "copy") {
        body.append(el("label", {}, "Copy which map"));
        const ids = GAME ? Object.keys(GAME.maps) : [];
        body.append(el("select", {
          onchange: (e) => { state.base = e.target.value; state.copyName = e.target.value + " copy"; rebuild(); },
        }, ...ids.map((i) => el("option", { value: i, selected: i === state.base }, i))));
        const showCopyId = el("p", { class: "hint" }, `The engine will know it as ${idFromName(state.copyName)}.`);
        body.append(el("label", {}, "Name it"));
        body.append(el("input", { value: state.copyName, oninput: (e) => { state.copyName = e.target.value; showCopyId.textContent = `The engine will know it as ${idFromName(state.copyName)}.`; } }));
        body.append(showCopyId);
        body.append(el("p", { class: "hint" },
          "A full, independent copy under its own id. The original map is never touched, "
          + "so freely editing this one -- blocks, warps, signs, people -- can't break it."));
      } else {
        body.append(el("label", {}, "Which map"));
        const ids = GAME ? Object.keys(GAME.maps) : [];
        body.append(el("select", { onchange: (e) => (state.base = e.target.value) },
          ...ids.map((i) => el("option", { value: i, selected: i === state.base }, i))));
        body.append(el("p", { class: "hint" }, "Your additions are appended, so the vanilla map keeps everything it had."));
      }

      body.append(el("div", { class: "row", style: "margin-top:12px" },
        el("button", { class: "primary", onclick: () => {
          const newId = idFromName(state.name);
          const copyId = idFromName(state.copyName);
          if (state.mode === "copy" && (GAME?.maps?.[copyId] || P.maps.some((x) => x.id === copyId)
              || P.mapDrafts.some((x) => x.id === copyId))) {
            toast("That name's id is already used — try a slightly different name", true); return;
          }
          const m = state.mode === "new" ? newMapRecord(newId, state.tileset, state.w, state.h)
            : state.mode === "copy" ? mapCopyFromVanilla(state.base, copyId)
            : mapFromVanilla(state.base);
          if (!m) { toast("Load game data first", true); return; }
          if (state.mode === "new") m.rec.label = state.name;
          if (state.mode === "copy") m.rec.label = state.copyName;
          P.mapDrafts.push(m);
          P.sel.map = m.uid;
          P.sel.mapEnt = null;
          touch();
          closeDialog();
          renderMapTab();
        } }, "Create"),
        el("button", { onclick: closeDialog }, "Cancel")));
    };
    rebuild();
    dialog("New map", body);
  };

  $("#btnImportTileset").onclick = importTilesetDialog;
  $("#btnExportTileset").onclick = exportTilesetSheet;

  $("#mapTools").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    selectMapTool(b.dataset.tool);
  });
  selectMapTool(mapTool);
  $("#showWalk").onchange = renderMapCanvas;
  $("#showGrid").onchange = renderMapCanvas;
  $("#showCoords").onchange = (e) => { if (!e.target.checked) $("#mapCoords").textContent = ""; };
  $("#zoneCompound").onchange = (e) => {
    const m = curMap();
    if (!m) return;
    const z = zoneOf(m);
    if (!e.target.checked && hasPaintedCollision(m)) {
      toast("Painted collision needs this on — clear it first", true);
      e.target.checked = true;
      return;
    }
    z.compound = e.target.checked;
    if (!z.compound) z.paintTs = m.rec.tileset;
    touch(); renderMapTab();
  };
  $("#zoneSubtile").onchange = (e) => {
    const m = curMap();
    if (!m) return;
    zoneOf(m).subtile = e.target.checked;
    touch(); renderMapTab();
  };
  wireMapCanvas();

  $("#dlgClose").onclick = closeDialog;

  window.addEventListener("beforeunload", () => save(true));

  renderAll();
  showTab("start");

  if (!Store.persistent) {
    toast("This browser blocks local storage — use Save file to keep your work");
  }
}

// Anything thrown after boot would otherwise leave a half-wired page, so make
// it visible rather than silent.
window.addEventListener("error", (e) => {
  toast((e.message || "Something went wrong").slice(0, 120), true);
});

function start() {
  try { boot(); }
  catch (e) { fatal("Oak's Lab could not start.", String(e && e.stack || e), null); }
}

// The script tag sits at the end of <body>, but readyState is checked anyway
// so the page still boots if it is ever injected after parsing.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
