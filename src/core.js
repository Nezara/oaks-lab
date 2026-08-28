"use strict";
/* ============================================================================
   Oak's Lab core — project state, the schema-driven form generator, the Lua
   emitter and the exporter.

   Everything the UI knows about the engine comes from PACK (built by
   tools/build-schema-pack.mjs out of the engine's own generated registry
   docs). Nothing about pokemon, moves or items is hardcoded here.
   ========================================================================== */

// Read an embedded JSON island without throwing. A throw at this point would
// kill the whole script before a single handler is attached, which looks to
// the user like "none of the buttons work" -- so failures are values here,
// reported by boot() as a visible banner.
function readEmbedded(id) {
  const node = document.getElementById(id);
  const raw = node ? node.textContent.trim() : "";
  if (!node) return { missing: true, why: `no <script id="${id}"> in the page` };
  // An unreplaced build placeholder means this is src/app.html, not a build.
  if (!raw || /^__[A-Z_]+__$/.test(raw)) return { unbuilt: true };
  try { return { value: JSON.parse(raw) }; }
  catch (e) { return { error: e.message }; }
}

const PACK_READ = readEmbedded("SCHEMA_PACK");
const PACK = PACK_READ.value || { registries: {}, commands: {}, manifest: [], starterRegistries: [] };

const GAME_READ = readEmbedded("GAMEDATA");
let GAME = GAME_READ.value || null;

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else if (k === "checked") n.checked = !!v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

let toastTimer;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "on" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 2600);
}

function dialog(title, body) {
  $("#dlgTitle").textContent = title;
  const host = $("#dlgBody");
  host.textContent = "";
  host.append(body);
  $("#dlg").showModal();
}
const closeDialog = () => $("#dlg").close();

/**
 * Every "New"/"Copy"/"Import" trigger across the five content workspaces
 * (Pokemon, NPC, Moves, Items, Maps) would otherwise silently overwrite
 * whatever unsaved draft is already sitting there. This asks first, so
 * half-finished sandbox exploration is never lost by accident -- only by a
 * deliberate "throw it away".
 *
 * `draft` is the current P.xDraft (or null); `label` is what to call it in
 * the sentence; `why` is the same draft-blocker string the workspace's own
 * "Add to the mod" button already greys out on, or null when it's ready;
 * `add` commits it exactly as that button would. `proceed` is whatever the
 * caller was about to do (open a copy dialog, start a blank one, etc.) --
 * run immediately if there was nothing to lose, or after the choice is made.
 */
function guardDraftReplace(draft, { label, why, add }, proceed) {
  if (!draft) { proceed(); return; }
  const body = el("div", {},
    el("p", {}, `${label} hasn't been added to the mod yet.`),
    why ? el("p", { class: "hint warn" }, why) : null,
    el("div", { class: "row", style: "margin-top:12px" },
      el("button", {
        class: "primary", disabled: !!why, title: why || "",
        onclick: () => { closeDialog(); add(); proceed(); },
      }, "Add it, then continue"),
      el("button", { class: "danger", onclick: () => { closeDialog(); proceed(); } }, "Throw it away"),
      el("button", { onclick: closeDialog }, "Cancel")));
  dialog("You have unsaved work", body);
}

/* ---------------------------------------------------------------- state -- */

const BLANK = () => ({
  meta: {
    id: "my_first_mod", name: "My First Mod", version: "0.1.0",
    author: "", description: "", github: "", api: 2, entry: "main.lua",
  },
  entries: [],   // content records            -> Content tab
  scripts: [],   // node graphs                -> Scripts tab
  maps: [],      // map records                -> Maps tab
  // A tileset the user imported from their own art, in the same shape
  // GAME.tilesets already uses. See applyCustomTilesets() in map.js.
  customTilesets: [],
  // A person with nowhere to stand cannot be appended to a map yet, so the
  // NPC workspace holds them here until step 3 gives them somewhere to be.
  npcDraft: null,
  // ...and the same for a species: a Pokemon is a content record, but it is
  // not put in P.entries until it has a name to be registered under.
  monDraft: null,
  // ...and a move, which can additionally be carrying who asked for it: a
  // move started from a species' move list goes back to that species the
  // moment it is added.
  moveDraft: null,
  // ...and an item, same reason.
  itemDraft: null,
  // ...and maps -- an ARRAY of them, unlike the others: confirming a warp
  // lines up right often means flipping between two not-yet-added floors of
  // the same building, so nothing stops a new one being started while others
  // are still in progress. None of these count as "in the mod" -- never in
  // P.maps, which Export and the Scripts tab's file preview both read
  // directly -- until "Add to the mod" on the Maps screen commits them.
  mapDrafts: [],
  sel: { entry: null, script: null, node: null, map: null, mapEnt: null, npc: null, mon: null, move: null, item: null },
});

let P = BLANK();
const STORE_KEY = "modforge.project.v1";

// Opened from file:// with site data blocked, or inside a sandboxed frame,
// touching window.localStorage throws on the property access itself. Probe it
// once and fall back to memory: the app still runs, it just forgets. Losing
// autosave is not a reason to lose the whole tool.
const Store = (() => {
  let backing = null;
  try {
    window.localStorage.setItem("__modforge_probe__", "1");
    window.localStorage.removeItem("__modforge_probe__");
    backing = window.localStorage;
  } catch { backing = null; }
  const mem = new Map();
  return {
    persistent: !!backing,
    get(k) { try { return backing ? backing.getItem(k) : (mem.get(k) ?? null); } catch { return null; } },
    set(k, v) { try { backing ? backing.setItem(k, v) : mem.set(k, v); } catch { mem.set(k, v); } },
  };
})();

function save(quiet) {
  Store.set(STORE_KEY, JSON.stringify(P));
  if (!quiet) toast(Store.persistent ? "Saved to this browser" : "Kept for now — use Save file to keep it for good");
}
function load() {
  try {
    const raw = Store.get(STORE_KEY);
    if (raw) P = Object.assign(BLANK(), JSON.parse(raw));
  } catch { /* a corrupt autosave must not brick the tool */ }
}

// Autosave is quiet and debounced; the Save button is for reassurance.
let autosaveTimer;
function touch() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { save(true); flashUpdated(); }, 600);
}

// A quiet "yes, that's saved" pulse in whichever content workspace is
// currently on screen, in the exact spot the old "Update" button sat --
// replaced with this on request: no click to make, it just appears once
// editing has actually paused (same 600ms debounce as autosave itself),
// which is what "finishes editing a field" means without a blur handler on
// every single input across five files. Content workspaces only, deliberately
// -- touch() also fires from the Scripts/Maps-tool side of things, which
// have no such badge to flash and just no-op here.
function flashUpdated() {
  const id = { npc: "npcUpdated", pokemon: "monUpdated", moves: "moveUpdated", items: "itemUpdated", maps: "mapUpdated" }[contentSub];
  const el = id && $("#" + id);
  if (!el) return;
  el.classList.add("show");
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => el.classList.remove("show"), 1500);
}

/* ------------------------------------------------------------ lua output -- */

const LUA_KEYWORDS = new Set(["and","break","do","else","elseif","end","false","for","function","if","in","local","nil","not","or","repeat","return","then","true","until","while"]);

function luaStr(s) {
  return '"' + String(s)
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"';
}
function luaKey(k) {
  return /^[A-Za-z_]\w*$/.test(k) && !LUA_KEYWORDS.has(k) ? k : "[" + luaStr(k) + "]";
}

// Arrays of short scalars stay on one line; everything else breaks. Readable
// output matters more than compactness -- the export is meant to be the
// user's next teacher.
function luaValue(v, indent = "  ") {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.startsWith("@lua:") ? v.slice(5) : luaStr(v);

  const pad = indent + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "{}";
    const flat = v.every((x) => typeof x === "number" || (typeof x === "string" && x.length < 24));
    if (flat) {
      const body = v.map((x) => luaValue(x, pad)).join(", ");
      if (body.length <= 68) return "{ " + body + " }";
      // Long numeric runs (map block arrays) wrap in fixed-width rows.
      const per = 16, lines = [];
      for (let i = 0; i < v.length; i += per) lines.push(pad + v.slice(i, i + per).map((x) => luaValue(x, pad)).join(", ") + ",");
      return "{\n" + lines.join("\n") + "\n" + indent + "}";
    }
    return "{\n" + v.map((x) => pad + luaValue(x, pad) + ",").join("\n") + "\n" + indent + "}";
  }

  const keys = Object.keys(v).filter((k) => v[k] !== undefined && v[k] !== "");
  if (!keys.length) return "{}";
  const parts = keys.map((k) => luaKey(k) + " = " + luaValue(v[k], pad));
  const oneLine = "{ " + parts.join(", ") + " }";
  if (oneLine.length <= 72 && !oneLine.includes("\n")) return oneLine;
  return "{\n" + keys.map((k) => pad + luaKey(k) + " = " + luaValue(v[k], pad) + ",").join("\n") + "\n" + indent + "}";
}

// A script row array prints one row per line -- that shape is the thing a
// modder will recognise from the wiki.
function luaRows(rows, indent) {
  const pad = indent + "  ";
  return "{\n" + rows.map((r) => pad + "{ " + r.map((a) => luaValue(a, pad)).join(", ") + " },").join("\n") + "\n" + indent + "}";
}

/* --------------------------------------------------- schema-driven forms -- */

function typeLabel(t) {
  switch (t.kind) {
    case "int": case "number":
      return t.min !== undefined && t.max !== undefined ? `${t.min}–${t.max}`
           : t.min !== undefined ? `≥ ${t.min}` : "number";
    case "ref": return t.registry;
    case "list": return "list of " + typeLabel(t.of);
    case "enum": return t.options.join(" / ");
    case "struct": return "{" + t.fields.map((f) => f.name).join(", ") + "}";
    case "lua": return "lua function";
    case "path": return "file";
    case "text": return "text";
    case "map": return "map";
    default: return t.kind;
  }
}

/**
 * Every id the player could mean for a registry: the ones the game already has,
 * plus the ones this mod is adding. Nobody has 151 species ids memorised, so a
 * field that wants an id offers a list rather than a text box.
 *
 * Returns null only when there is genuinely no list to offer, in which case
 * the caller falls back to free text -- which still produces a valid mod.
 */
function allIds(registry) {
  const base = GAME?.ids?.[registry] || null;

  const mine = P.entries
    .filter((e) => e.registry === registry && e.verb === "register" && e.id)
    .map((e) => ({ id: e.id, name: e.data?.name || e.id, mine: true }));
  if (registry === "maps") {
    for (const m of P.maps) if (m.verb === "register" && m.id) mine.push({ id: m.id, name: m.rec.label || m.id, mine: true });
  }

  // Not-yet-added drafts belong in the list too, clearly marked -- other
  // content should be able to point at a species, move, item or map that is
  // still being built (an evolution target, a warp destination, a wild
  // encounter, a "has item" check) without waiting on "Add to the mod" first.
  const draft = { pokemon: P.monDraft, moves: P.moveDraft, items: P.itemDraft }[registry];
  if (draft?.id) mine.push({ id: draft.id, name: (draft.data?.name || draft.id) + " (not added yet)", mine: true, draft: true });
  if (registry === "maps") {
    for (const m of P.mapDrafts) if (m.id) mine.push({ id: m.id, name: (m.rec.label || m.id) + " (not added yet)", mine: true, draft: true });
  }

  if (!base && !mine.length) return null;
  const seen = new Set(mine.map((o) => o.id));
  return [...mine, ...(base || []).filter((o) => !seen.has(o.id))];
}

const idLabel = (o) =>
  (o.name && o.name !== o.id ? `${o.name} — ${o.id}` : o.id);

/**
 * Split a list from allIds() into "Your mod" and "Base game" <optgroup>s so
 * 151+ vanilla entries never bury the handful the user is actually building.
 * Shared by refSelect below and the couple of hand-rolled dropdowns (an
 * evolution target's "make a new one" option, a wild-encounter slot's own
 * annotation) that mix in something extra and so can't just call refSelect.
 */
function appendIdOptions(sel, options, current, labelFor = idLabel) {
  const mine = options.filter((o) => o.mine);
  const base = options.filter((o) => !o.mine);
  const opt = (o) => el("option", { value: o.id, selected: o.id === current }, labelFor(o));
  if (mine.length) sel.append(el("optgroup", { label: "Your mod" }, ...mine.map(opt)));
  if (mine.length && base.length) sel.append(el("optgroup", { label: "Base game" }, ...base.map(opt)));
  else sel.append(...base.map(opt));
}

/**
 * A dropdown over a registry's ids. Long lists get a filter box above them,
 * because scrolling 222 maps on a phone is not a user interface.
 * `opts.noFilter` skips that box even for a long list, for a caller drawing
 * several of these somewhere too tight for six of them (the Pokemon-team
 * block's rows) -- the native select's own type-ahead still jumps to an
 * option by its first letters.
 */
function refSelect(registry, get, set, opts = {}) {
  const wrap = el("div", {});
  const options = allIds(registry);

  if (!options) {
    wrap.append(el("input", {
      value: get() || "", placeholder: registry.toUpperCase() + " id",
      oninput: (e) => { set(e.target.value.toUpperCase()); touch(); opts.onChange?.(); },
    }));
    wrap.append(el("div", { class: "hint" }, "Load game data to pick this from a list."));
    return wrap;
  }

  const sel = el("select", {
    onchange: (e) => { set(e.target.value); touch(); opts.onChange?.(); },
  });

  const fill = (filter) => {
    const v = get() || "";
    const needle = (filter || "").trim().toLowerCase();
    const shown = needle
      ? options.filter((o) => o.id.toLowerCase().includes(needle) || (o.name || "").toLowerCase().includes(needle))
      : options;
    sel.textContent = "";
    sel.append(el("option", { value: "" }, opts.blank || "— choose —"));
    // A value from another mod is not in our list; keep it rather than
    // silently dropping the user's data on the floor.
    if (v && !options.some((o) => o.id === v)) sel.append(el("option", { value: v, selected: true }, v + "  (not in this game)"));
    appendIdOptions(sel, shown, v);
    if (needle && !shown.length) sel.append(el("option", { value: "" }, "nothing matches"));
  };

  if (options.length > 40 && !opts.noFilter) {
    wrap.append(el("input", {
      type: "search", placeholder: `search ${options.length}…`,
      style: "margin-bottom:4px",
      oninput: (e) => fill(e.target.value),
    }));
  }
  fill("");
  wrap.append(sel);
  return wrap;
}

// Turn what the user typed into the SHOUTY_ID the engine wants, so nobody has
// to learn the convention before they can name something.
function idFromName(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 28) || "UNNAMED";
}

function defaultFor(t) {
  switch (t.kind) {
    case "int": case "number": return t.min ?? 0;
    case "bool": return false;
    case "enum": return t.options[0];
    case "list": return [];
    case "struct": { const o = {}; for (const f of t.fields) if (!f.optional) o[f.name] = 0; return o; }
    case "map": return {};
    default: return "";
  }
}

/**
 * Render one schema-typed field into `host`.
 * get()/set() read and write the owning object so nested structs and lists
 * compose without the caller tracking paths.
 */
function renderField(host, name, type, get, set, opts = {}) {
  const wrap = el("div", { class: "field" });
  const head = el("div", { class: "k" },
    el("span", {}, opts.label || name),
    opts.required ? el("span", { class: "req" }, "*") : null,
    el("span", { class: "ty" }, typeLabel(type)));
  if (!opts.bare) wrap.append(head);

  const v = get();

  const commit = (val) => { set(val); touch(); opts.onChange?.(); };

  switch (type.kind) {
    case "lua":
      wrap.append(el("div", { class: "lua-note" },
        "This field is a Lua function. Oak's Lab leaves it alone — add it by hand in main.lua after export."));
      break;

    case "bool":
      wrap.append(el("label", { style: "margin:0" },
        el("input", { type: "checkbox", checked: !!v, onchange: (e) => commit(e.target.checked) }),
        "yes"));
      break;

    case "enum": {
      const sel = el("select", { onchange: (e) => commit(e.target.value) },
        ...type.options.map((o) => el("option", { value: o, selected: o === v }, o)));
      wrap.append(sel);
      break;
    }

    case "int": case "number": {
      const inp = el("input", {
        type: "number", value: v === "" || v == null ? "" : v,
        min: type.min, max: type.max, step: type.kind === "int" ? 1 : "any",
        oninput: (e) => commit(e.target.value === "" ? "" : Number(e.target.value)),
      });
      wrap.append(inp);
      break;
    }

    case "text": {
      wrap.append(el("textarea", {
        rows: 3, value: v || "", placeholder: "Press Enter for a new line in the text box",
        oninput: (e) => commit(e.target.value),
      }));
      break;
    }

    case "ref":
      wrap.append(refSelect(type.registry, get, (nv) => set(nv), { onChange: opts.onChange }));
      break;

    case "struct": {
      const sub = el("div", { class: "sub" });
      const obj = (v && typeof v === "object") ? v : {};
      for (const f of type.fields) {
        renderField(sub, f.name, f.type.kind === "any" ? { kind: "number" } : f.type,
          () => obj[f.name], (nv) => { obj[f.name] = nv; set(obj); },
          { required: !f.optional, onChange: opts.onChange });
      }
      wrap.append(sub);
      break;
    }

    case "list": {
      const arr = Array.isArray(v) ? v : [];
      const sub = el("div", { class: "sub" });
      arr.forEach((_, i) => {
        const row = el("div", { class: "listrow" });
        const cell = el("div");
        renderField(cell, String(i), type.of,
          () => arr[i], (nv) => { arr[i] = nv; set(arr); },
          { bare: type.of.kind !== "struct", label: "#" + (i + 1), onChange: opts.onChange });
        row.append(cell, el("button", {
          class: "danger", title: "remove",
          onclick: () => { arr.splice(i, 1); set(arr); touch(); opts.onChange?.(); opts.rerender?.(); },
        }, "×"));
        sub.append(row);
      });
      sub.append(el("button", {
        onclick: () => { arr.push(defaultFor(type.of)); set(arr); touch(); opts.onChange?.(); opts.rerender?.(); },
      }, "+ add"));
      wrap.append(sub);
      break;
    }

    case "map": case "any": default: {
      const isObj = v && typeof v === "object";
      wrap.append(el("textarea", {
        rows: isObj ? 4 : 1,
        value: isObj ? JSON.stringify(v, null, 1) : (v ?? ""),
        placeholder: type.kind === "any" ? "value (JSON for tables)" : "{ }",
        oninput: (e) => {
          const raw = e.target.value.trim();
          if (raw.startsWith("{") || raw.startsWith("[")) {
            try { commit(JSON.parse(raw)); e.target.style.borderColor = ""; }
            catch { e.target.style.borderColor = "var(--bad)"; }
          } else commit(raw === "" ? "" : (isNaN(Number(raw)) ? raw : Number(raw)));
        },
      }));
      break;
    }
  }
  host.append(wrap);
}

/* ------------------------------------------------------------- exporting -- */

// Build the { mapId -> { talk: {...}, onEnter: [...] } } tree that the
// map_scripts registry takes. Several scripts on one map merge into one
// register call, which is what compose semantics expects.
function scriptsByMap() {
  const out = {};
  for (const s of P.scripts) {
    if (!s.mapId) continue;
    const rows = compileScript(s).rows;
    if (!rows.length) continue;
    const entry = (out[s.mapId] ||= {});
    if (s.kind === "talk") {
      (entry.talk ||= {})[s.textKey || ("TEXT_" + s.name.toUpperCase())] = rows;
    } else {
      entry[s.kind] = rows;
    }
  }
  return out;
}

function buildManifest() {
  const m = {
    id: P.meta.id, name: P.meta.name, version: P.meta.version,
    entry: "main.lua", api: 2,
  };
  if (P.meta.description) m.description = P.meta.description;
  if (P.meta.author) m.author = P.meta.author;
  if (P.meta.github) m.github = P.meta.github;
  return JSON.stringify(m, null, 2) + "\n";
}

function buildLua() {
  // Whether an NPC battles is read off their graph, not stored separately;
  // fold that into the map object here so an export is right no matter which
  // editor a "Start a battle" block was last added or removed from.
  if (typeof syncAllNpcBattles === "function") syncAllNpcBattles();
  // A species' picture and cry are authored on the Pokemon screen but land in
  // fields (spriteFront/spriteBack/icon/cry) and registries of their own, so
  // they are folded in here for the same reason -- the record on the way out
  // has to match what the screen last said, whichever screen that was.
  if (typeof syncMonArt === "function") syncMonArt();
  if (typeof syncMonCry === "function") syncMonCry();

  const L = [];
  L.push("-- " + P.meta.name + " " + P.meta.version);
  if (P.meta.author) L.push("-- by " + P.meta.author);
  L.push("-- generated by Oak's Lab; plain Lua from here on -- edit freely.");
  L.push("");
  // A freeform move animation is the one thing this file ever emits that is
  // code rather than a mod.content record -- there is no registry route for
  // "a new arrangement of tiles", only for borrowing the game's own. It has
  // to live as locals ABOVE the returned function, not inside it, so every
  // move's hook closes over the same one copy.
  const freeformPreamble = typeof freeformRuntimePreamble === "function" ? freeformRuntimePreamble() : "";
  if (freeformPreamble) { L.push(freeformPreamble); L.push(""); }
  L.push("return function(mod)");

  const section = (title) => { L.push(""); L.push("  -- " + title); };

  if (P.entries.length) {
    section("content records");
    for (const e of P.entries) {
      if (e.verb === "remove") { L.push(`  mod.content.${e.registry}:remove(${luaStr(e.id)})`); continue; }
      // An empty list is dropped as noise unless the schema requires the
      // field -- `learnset = {}` is a real answer, not an omission.
      const reg = PACK.registries[e.registry];
      const clean = {};
      for (const [k, v] of Object.entries(e.data || {})) {
        if (v === "" || v === null || v === undefined) continue;
        if (Array.isArray(v) && !v.length && !reg?.fields[k]?.required) continue;
        clean[k] = v;
      }
      L.push(`  mod.content.${e.registry}:${e.verb}(${luaStr(e.id)}, ${luaValue(clean, "  ")})`);
    }
  }

  // Imported overworld art is a content record like any other, but it is
  // authored on the NPC screen rather than the Content tab, so it is
  // collected here instead of living in P.entries.
  const customSprites = [
    ...(typeof customSpriteRecords === "function" ? customSpriteRecords() : []),
    ...(typeof monOverworldSpriteRecords === "function" ? monOverworldSpriteRecords() : []),
  ];
  if (customSprites.length) {
    section("sprites you imported");
    for (const s of customSprites) {
      L.push(`  mod.content.sprites:register(${luaStr(s.id)}, ${luaValue(s.data, "  ")})`);
    }
  }

  // Same for a species' cry -- authored on the Pokemon screen, but its own
  // registry rather than a field on the species.
  const cries = typeof monCryRecords === "function" ? monCryRecords() : [];
  if (cries.length) {
    section("cries");
    for (const c of cries) {
      L.push(`  mod.content.cries:register(${luaStr(c.id)}, ${luaValue(c.data, "  ")})`);
    }
  }

  // A move's animation, same idea again: authored on the Moves screen, but it
  // lives in battle_anims rather than on the move. The id prefix is what
  // routes each record into the right engine table -- a bare move id is the
  // animation itself, "subanim:<n>" one burst of it, "tilesheet:<n>" the
  // picture those bursts are cut from.
  const animRecs = typeof moveAnimRecords === "function" ? moveAnimRecords() : [];
  if (animRecs.length) {
    section("move animations");
    for (const a of animRecs) {
      L.push(`  mod.content.battle_anims:register(${luaStr(a.id)}, ${luaValue(a.data, "  ")})`);
    }
  }

  // A move's imported sound, same indirection as a cry but through the sfx
  // registry: the move's own anim.sound just names this key.
  const moveSounds = typeof moveSoundEffectRecords === "function" ? moveSoundEffectRecords() : [];
  if (moveSounds.length) {
    section("move sounds you imported");
    for (const s of moveSounds) {
      L.push(`  mod.content.sfx:register(${luaStr(s.id)}, ${luaValue(s.data, "  ")})`);
    }
  }

  // A hand-painted animation, wired to the shared helper the preamble above
  // defined (which is why this only ever prints hook registrations, never
  // the strip data itself -- that already sits in the preamble's table).
  const freeformHooks = typeof freeformRuntimeHooks === "function" ? freeformRuntimeHooks() : [];
  if (freeformHooks.length) {
    section("hand-painted move animations");
    for (const line of freeformHooks) L.push(line);
  }

  // And the one thing on that screen that is genuinely code: a status chance
  // the game has no effect for. Written out longhand rather than hidden,
  // because reading it is how somebody gets past what this tool can do.
  const fxRecs = typeof moveEffectRecords === "function" ? moveEffectRecords() : [];
  if (fxRecs.length) {
    section("move effects of your own");
    for (const f of fxRecs) {
      L.push(`  -- ${f.why}`);
      L.push(`  mod.content.move_effects:register(${luaStr(f.id)}, {`);
      L.push(f.body);
      L.push(`  })`);
    }
  }

  // Same idea as move effects, one screen over: an item whose behavior is not
  // one of the engine's native levers (a TM/HM's `machine` field, or nothing
  // at all) needs an item_effects block written out. This also covers the
  // one-line trick a new Poke Ball variant needs -- see itemBallRecords below.
  const itemFxRecs = typeof itemEffectRecords === "function" ? itemEffectRecords() : [];
  if (itemFxRecs.length) {
    section("item effects of your own");
    for (const f of itemFxRecs) {
      L.push(`  -- ${f.why}`);
      L.push(`  mod.content.item_effects:register(${luaStr(f.id)}, {`);
      L.push(f.body);
      L.push(`  })`);
    }
  }

  // A new Poke Ball variant needs a catch-formula record of its own -- the
  // engine's ball math is keyed by item id in a real registry, unlike almost
  // everything else an item can do.
  const ballRecs = typeof itemBallRecords === "function" ? itemBallRecords() : [];
  if (ballRecs.length) {
    section("ball catch formulas of your own");
    for (const b of ballRecs) {
      L.push(`  mod.content.balls:register(${luaStr(b.id)}, ${luaValue(b.data, "  ")})`);
    }
  }

  // A zone's own compounded tileset has to be registered BEFORE the map that
  // names it, or the map loads pointing at a tileset the engine has not seen.
  const zoneTs = typeof zoneTilesetRecords === "function" ? zoneTilesetRecords() : [];
  if (zoneTs.length) {
    section("tilesets your maps compounded");
    for (const t of zoneTs) {
      L.push(`  mod.content.tilesets:register(${luaStr(t.id)}, ${luaValue(t.data, "  ")})`);
    }
  }

  if (P.maps.length) {
    section("maps");
    for (const m of P.maps) {
      const rec = mapRecordForExport(m);
      L.push(`  mod.content.maps:${m.verb}(${luaStr(m.id)}, ${luaValue(rec, "  ")})`);
    }
  }

  const byMap = scriptsByMap();
  if (Object.keys(byMap).length) {
    section("scripts");
    for (const [mapId, value] of Object.entries(byMap)) {
      // Rows print one-per-line; luaValue would collapse them, so the talk
      // tables are assembled by hand here.
      const inner = [];
      if (value.talk) {
        const keys = Object.entries(value.talk)
          .map(([k, rows]) => "      " + luaKey(k) + " = " + luaRows(rows, "      ") + ",");
        inner.push("    talk = {\n" + keys.join("\n") + "\n    },");
      }
      for (const [k, rows] of Object.entries(value)) {
        if (k === "talk") continue;
        inner.push("    " + luaKey(k) + " = " + luaRows(rows, "    ") + ",");
      }
      L.push(`  mod.content.map_scripts:register(${luaStr(mapId)}, {`);
      L.push(inner.join("\n"));
      L.push("  })");
    }
  }

  if (!P.entries.length && !P.maps.length && !customSprites.length && !animRecs.length
      && !freeformHooks.length && !Object.keys(byMap).length) {
    L.push("  -- nothing yet: add content on the Content or Scripts tab.");
  }

  L.push("end");
  L.push("");
  return L.join("\n");
}

function buildReadme() {
  return [
    "# " + P.meta.name,
    "",
    P.meta.description || "_No description yet._",
    "",
    "## Install",
    "",
    "Unzip into `Mods/" + P.meta.id + "/` next to the game executable, then enable",
    "it in Options → Mods.",
    "",
    "## What it changes",
    "",
    ...changeSummary().map((c) => "- " + c),
    "",
  ].join("\n");
}

function changeSummary() {
  const out = [];
  const byReg = {};
  for (const e of P.entries) (byReg[e.registry] ||= []).push(e);
  for (const [reg, list] of Object.entries(byReg)) {
    out.push(`${list.length} ${reg} record${list.length > 1 ? "s" : ""} (${[...new Set(list.map((e) => e.verb))].join(", ")})`);
  }
  if (P.maps.length) out.push(`${P.maps.length} map${P.maps.length > 1 ? "s" : ""}`);
  const n = P.scripts.filter((s) => s.mapId).length;
  if (n) out.push(`${n} script${n > 1 ? "s" : ""}`);
  return out.length ? out : ["Nothing yet."];
}

function files() {
  return [
    { name: "manifest.json", body: buildManifest() },
    { name: "main.lua",      body: buildLua() },
    { name: "README.md",     body: buildReadme() },
    // Imported art is bytes, not text. It has no `body`, so anything that
    // wants to show a file has to ask for `bytes` first.
    ...(typeof customArtFiles === "function" ? customArtFiles() : []),
    ...(typeof monArtFiles === "function" ? monArtFiles() : []),
    ...(typeof monCryAudioFiles === "function" ? monCryAudioFiles() : []),
    ...(typeof moveAnimArtFiles === "function" ? moveAnimArtFiles() : []),
    ...(typeof moveSoundAudioFiles === "function" ? moveSoundAudioFiles() : []),
    ...(typeof zoneTilesetFiles === "function" ? zoneTilesetFiles() : []),
  ];
}
const fileSize = (f) => (f.bytes ? f.bytes.length : new TextEncoder().encode(f.body).length);

/* -------------------------------------------------------------- linting -- */

// A fast local pass for the mistakes a beginner actually makes. The engine's
// own modkit.py is the real gate and runs in CI; this is the fast feedback
// half of that pair, not a replacement for it.
function lint() {
  const out = [];
  const bad = (msg) => out.push({ level: "bad", msg });
  const warn = (msg) => out.push({ level: "warn", msg });

  if (!/^[A-Za-z0-9_-]+$/.test(P.meta.id)) bad("Mod id must be letters, numbers, _ or - only.");
  if (!/^\d+\.\d+\.\d+/.test(P.meta.version)) warn("Version is not semver (1.2.3) — the launcher compares versions with it.");
  if (!P.meta.description) warn("No description — the mod manager shows it.");
  if (P.meta.github && !/^[\w.-]+\/[\w.-]+$/.test(P.meta.github)) bad('github must look like "owner/repo".');

  // A draft is invisible to everything else that reads P (Export's own
  // content-detection, the file list, this very lint pass otherwise) right
  // up until export, which is exactly how someone ends up shipping a mod
  // with a warp to a map that quietly never made it in. Surfaced here as a
  // simple, unmissable "you have unfinished work" nudge, separate from the
  // more specific dangling-reference checks below.
  if (P.npcDraft) warn(`"${npcName(P.npcDraft)}" is a draft NPC that hasn't been added to the mod — it won't ship.`);
  if (P.monDraft) warn(`"${monName(P.monDraft)}" is a draft Pokemon that hasn't been added to the mod — it won't ship.`);
  if (P.moveDraft) warn(`"${moveName(P.moveDraft)}" is a draft move that hasn't been added to the mod — it won't ship.`);
  if (P.itemDraft) warn(`"${itemName(P.itemDraft)}" is a draft item that hasn't been added to the mod — it won't ship.`);
  for (const m of P.mapDrafts || []) {
    warn(`Map "${m.rec.label || m.id}" hasn't been added to the mod — it won't ship.`);
  }

  const seen = new Set();
  for (const e of P.entries) {
    const key = e.registry + "/" + e.id;
    if (seen.has(key)) bad(`Two records both target ${key}.`);
    seen.add(key);
    if (!e.id) { bad(`A ${e.registry} record has no id.`); continue; }
    const reg = PACK.registries[e.registry];
    if (reg && e.verb === "register") {
      for (const f of reg.order) {
        if (reg.fields[f].required && reg.fields[f].type.kind !== "lua") {
          const v = e.data?.[f];
          // An empty required list is fine; an absent one is not.
          if (v === undefined || v === "") bad(`${e.registry} "${e.id}" is missing required field ${f}.`);
        }
      }
    }
  }

  // A warp or script can point at a map id that reads as real right up
  // until export -- the Maps screen lets several drafts sit side by side
  // specifically so warps between them can be wired up before either ships
  // (see [[oaks-lab-content-draft-gating]]) -- but a draft that never gets
  // "Add to the mod" leaves the reference dangling with nothing to say so.
  // Checked against both what this mod ships AND the vanilla map list, since
  // "doesn't exist at all" (a typo, a deleted map) is the same shape of
  // broken as "not added yet" and deserves the same loud warning.
  const draftMapIds = new Set((P.mapDrafts || []).map((m) => m.id));
  const mapExists = (id) => P.maps.some((m) => m.id === id) || !!GAME?.maps?.[id];
  const mapProblem = (id) => draftMapIds.has(id)
    ? `"${id}", which is still a draft on the Maps screen — it won't ship until you press "Add to the mod" there`
    : `"${id}", which doesn't exist`;

  for (const m of P.maps) {
    if (m.verb === "register" && (m.rec.index ?? 0) < 1000) {
      warn(`Map "${m.id}" uses index ${m.rec.index ?? 0}; new maps should be 1000+ (vanilla tops out at 247).`);
    }
    // On a patch, only the objects this mod added are ours to complain about;
    // vanilla NPCs point at TEXT constants the engine already defines.
    const mine = m.verb === "patch" ? (m.rec._vanillaCounts?.objects ?? 0) : 0;
    for (const o of (m.rec.objects || []).slice(mine)) {
      if (o.text && !P.scripts.some((s) => s.textKey === o.text)) {
        warn(`NPC "${o.name || o.index}" on ${m.id} points at ${o.text}, which no script defines.`);
      }
    }
    for (const w of m.rec.warps || []) {
      if (w.destMap && !mapExists(w.destMap)) {
        bad(`A warp on "${m.id}" leads to ${mapProblem(w.destMap)}.`);
      }
      // A warps-table entry is not enough by itself -- src/world/Map.lua
      // only fires it when the cell's own tile is flagged doorTiles/warpTiles
      // too. Missing that is silent in-game (the player just walks over it),
      // so it has to be caught here or it isn't caught at all.
      if (typeof zoneIsWarpTile === "function" && !zoneIsWarpTile(m, w.x, w.y)) {
        bad(`A warp on "${m.id}" at cell (${w.x}, ${w.y}) sits on a tile that isn't a door/warp tile `
          + `— the engine won't fire it there. Paint that cell with a tile that already is one, or `
          + `mark it with the Warp tile tool.`);
      }
    }
  }

  for (const s of P.scripts) {
    if (!s.mapId) { warn(`Script "${s.name}" is not attached to a map, so it will not ship.`); continue; }
    if (!mapExists(s.mapId)) bad(`Script "${s.name}" is attached to ${mapProblem(s.mapId)}.`);
    const r = compileScript(s);
    for (const e of r.errors) bad(`Script "${s.name}": ${e}`);
    if (r.unreached.length) warn(`Script "${s.name}" has ${r.unreached.length} block(s) nothing leads to.`);
  }

  return out;
}

/* ------------------------------------------------------------------ zip -- */

// Minimal STORE-only zip writer. No compression, no dependencies -- a mod is
// a few KB of text and the launcher does not care.
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const u16 = (v) => [v & 255, (v >> 8) & 255];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.bytes || enc.encode(e.body);
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes,
    ]);
    chunks.push(local, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...nameBytes,
    ]));
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
