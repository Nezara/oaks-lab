"use strict";
/* ============================================================================
   Oak's Lab — the NPC workspace.

   The Start tab's wizard asked its questions once, in a modal, and then threw
   you at three different tabs to change any of the answers. This is the same
   questions as a workspace instead: one scrolling column of numbered steps
   you can come back to in any order, with the node editor docked underneath
   it so a person's words are never more than a drag away from the person.

   Nothing new is stored. An NPC is still a map object inside a map record --
   exactly what gets exported -- so the Maps tab, the linter and main.lua all
   keep seeing what they saw before. The extra authoring answers this screen
   collects (which picture, imported art) ride along on the same object under
   underscore-prefixed keys, and are stripped on the way out.
   ========================================================================== */

/* --------------------------------------------------------- sub-tab strip -- */

let contentSub = "npc";

function showContentSub(name) {
  contentSub = name;
  $$("#contentSub button").forEach((b) => b.classList.toggle("on", b.dataset.sub === name));
  const which = name === "npc" ? "npc"
    : name === "pokemon" ? "mon"
    : name === "moves" ? "move"
    : name === "items" ? "item"
    : name === "maps" ? "map"
    : name === "records" ? "records" : "npc";
  $$(".subpane").forEach((p) => p.classList.toggle("on", p.id === "sub-" + which));
  if (which === "npc") { renderNpcTab(); setDock(dockWant); }
  if (which === "mon") renderMonTab();
  if (which === "move") renderMoveTab();
  if (which === "item") renderItemTab();
  if (which === "map") renderMapTab();
  if (which === "records") { renderEntryList(); renderEntryForm(); renderEntryDoc(); }
}

/* ------------------------------------------------------------------ art -- */

// Decoded sheets arrive as base64 inside gamedata. Decoding one is cheap but
// not free, and the same beauty sprite shows up in a 73-tile picker, so they
// are decoded once and reused.
const artCache = new Map();

function artImage(key, b64) {
  if (artCache.has(key)) return artCache.get(key);
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  artCache.set(key, img);
  return img;
}

/**
 * One rectangle of a sheet, drawn at whole-pixel scale into its own canvas.
 *
 * The canvas paints itself when the image arrives rather than asking the page
 * to re-render, so a picker full of 73 sprites settles without 73 re-layouts.
 */
function artCanvas(key, b64, sx, sy, sw, sh, scale) {
  const cv = el("canvas", { width: sw * scale, height: sh * scale });
  cv.style.width = (sw * scale) + "px";
  cv.style.height = (sh * scale) + "px";
  const img = artImage(key, b64);
  const paint = () => {
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(img, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale);
  };
  if (img.complete && img.naturalWidth) paint();
  else img.addEventListener("load", paint, { once: true });
  return cv;
}

const FRAME_PX = 16;                     // the engine's default overworld frame size
const frameNames = () => GAME?.frameNames || ["down", "up", "left", "down (step)", "up (step)", "left (step)"];

// Imported art is keyed by its own bytes rather than by whose art it is.
// artCache never evicts, so a per-NPC key meant re-importing a sheet for
// someone kept showing the sheet they replaced -- and re-importing is the
// normal way to work now that the studio can be reopened to recut a sheet.
const artKey = (prefix, a) => `${prefix}:${a.png ? a.png.length + ":" + a.png.slice(0, 24) : "none"}`;

// Whatever art an NPC's overworld slot is currently pointing at: the game's
// own sheet, or one the user imported. Same shape either way so the preview
// and the frame strip do not care which it is.
function overworldArt(n) {
  const custom = n._art?.overworld;
  if (custom?.source === "custom") return { key: artKey("own", custom), ...custom };
  const sheet = GAME?.spriteSheets?.[n.sprite];
  return sheet ? { key: "game:" + n.sprite, ...sheet } : null;
}

function facingArt(n) {
  const a = n._art?.facing;
  if (!a) return null;
  if (a.source === "custom") return { key: artKey("ownface", a), ...a };
  const pic = GAME?.facingPics?.[a.id];
  return pic ? { key: "face:" + a.id, ...pic } : null;
}

function backArt(n) {
  const a = n._art?.back;
  if (!a) return null;
  if (a.source === "custom") return { key: artKey("ownback", a), ...a };
  const pic = GAME?.backPics?.[a.id];
  return pic ? { key: "back:" + a.id, ...pic } : null;
}

// A sprite's standing-still frame, at a size that reads on a phone. An
// overworld sheet is a strip and gets cut into frames; a facing or back
// picture is one image and is shown whole.
function spriteThumb(art, scale = 3, frame = 0) {
  if (!art) return null;
  const fw = art.frameW || art.w;
  const fh = art.frameH || (art.frames ? Math.round(art.h / art.frames) : art.h);
  return artCanvas(art.key, art.png, 0, frame * fh, fw, fh, scale);
}

/**
 * Save whatever art a slot is currently showing as a PNG.
 *
 * Deliberately does not care whether it was imported or is one of the game's
 * own -- both are just PNG bytes by the time they reach here. Exporting a
 * vanilla sheet to open in a real art program and paint over is the fastest
 * way to make a new sprite that actually fits in beside the others.
 */
function exportArt(art, base) {
  if (!art?.png) { toast("Nothing to export in that slot", true); return; }
  download(new Blob([base64Bytes(art.png)], { type: "image/png" }),
    (base || "sprite").replace(/[^a-z0-9_-]+/gi, "_") + ".png");
}

/* ------------------------------------------------------ overworld preview -- */

// Which frames of the strip each direction uses, as [name, stand, step,
// mirrored]. Right is the one direction the engine does not store -- it
// draws left flipped -- so the preview flips it too rather than showing a
// blank where a direction should be.
const OW_DIRS = [
  ["facing down", 0, 3, false],
  ["facing up", 1, 4, false],
  ["facing left", 2, 5, false],
  ["facing right", 2, 5, true],
];

// The four standing poses first, then -- once a sheet has the frames for it
// -- the same four again as a walk cycle. Arrowing past "facing right" is
// what carries you into walking rather than a separate button for it.
function owStates(total) {
  const dirs = OW_DIRS.filter((d) => d[1] < total);
  const states = dirs.map((d) => ({ label: d[0], stand: d[1], step: null, mirror: d[3] }));
  if (total >= 6) {
    for (const d of dirs) {
      if (d[2] < total) states.push({ label: d[0] + " (walking)", stand: d[1], step: d[2], mirror: d[3] });
    }
  }
  return states;
}

// State outlives any one render: renderNpcTab runs on every keystroke
// elsewhere on the form, and snapping back to "facing down" each time would
// make the arrows pointless. owTimer is the walk cycle's own clock -- there
// is no button for it, so it starts and stops itself as the state it belongs
// to comes in and out of view.
let owState = 0, owTimer = null, owPhase = 0;

/**
 * One picture of this person: facing whichever way was last chosen, and
 * walking if arrowed past all four standing poses.
 */
function owPreview(art) {
  clearInterval(owTimer);
  owTimer = null;
  const wrap = el("div", { class: "owpreview" });
  if (!art) return wrap;

  const total = art.frames || Math.max(1, Math.round(art.h / (art.frameH || FRAME_PX)));
  const fw = art.frameW || art.w;
  const fh = art.frameH || Math.round(art.h / total);
  const states = owStates(total);
  if (owState >= states.length) owState = 0;

  const scale = 4;
  const cv = el("canvas", { width: fw * scale, height: fh * scale });
  cv.style.width = (fw * scale) + "px";
  cv.style.height = (fh * scale) + "px";
  const img = artImage(art.key, art.png);

  const paint = () => {
    const s = states[owState];
    const frame = s.step !== null && owPhase ? s.step : s.stand;
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, cv.width, cv.height);
    c.save();
    if (s.mirror) { c.translate(cv.width, 0); c.scale(-1, 1); }
    c.drawImage(img, 0, frame * fh, fw, fh, 0, 0, fw * scale, fh * scale);
    c.restore();
  };
  if (img.complete && img.naturalWidth) paint();
  else img.addEventListener("load", paint, { once: true });

  const label = el("span", { class: "owdir" }, states[owState].label);
  const sync = () => {
    clearInterval(owTimer);
    owPhase = 0;
    const s = states[owState];
    owTimer = s.step !== null ? setInterval(() => { owPhase ^= 1; paint(); }, 220) : null;
    label.textContent = s.label;
    paint();
  };
  const turn = (by) => { owState = (owState + by + states.length) % states.length; sync(); };
  sync();

  wrap.append(
    el("button", { class: "fixed owturn", onclick: () => turn(-1), title: "Turn" }, "◀"),
    el("div", { class: "owstage" }, cv),
    el("button", { class: "fixed owturn", onclick: () => turn(1), title: "Turn" }, "▶"),
    el("div", { class: "owmeta" }, label));
  return wrap;
}

/* ---------------------------------------------------- the record itself -- */

// Every NPC this mod adds, wherever it lives. Vanilla objects on a patched
// map are somebody else's; only what the mod appends is ours to list.
function allNpcs() {
  const out = [];
  // A committed NPC can be standing on a map that is itself still a draft
  // (see mapRecordFor below) -- it stays visible here either way, since the
  // NPC itself really is added; only the host map's own export depends on
  // whether THAT gets added too.
  for (const m of [...P.maps, ...P.mapDrafts]) {
    const from = m.verb === "patch" ? (m.rec._vanillaCounts?.objects ?? 0) : 0;
    (m.rec.objects || []).forEach((o, i) => {
      if (i < from) return;
      // A Pokemon standing in the world is the same kind of map object, but it
      // belongs to the Pokemon workspace and is edited there. Listing it here
      // too would put a Mewtwo in the people dropdown and let two screens
      // fight over one record.
      if (o._monEncounter) return;
      // Objects dropped by the Maps tab's NPC tool have no uid yet; give them
      // one so this screen can hold on to them across a re-render.
      o._uid ||= uid();
      out.push({ npc: o, map: m, i });
    });
  }
  return out;
}

const npcName = (n) => n?._display || n?.name || "(unnamed)";

function curNpc() {
  if (P.sel.npc === "draft") return P.npcDraft || null;
  return allNpcs().find((r) => r.npc._uid === P.sel.npc)?.npc || null;
}
const npcHome = (n) => allNpcs().find((r) => r.npc === n) || null;
const isDraft = (n) => !!n && n === P.npcDraft;

function blankNpc() {
  return {
    _uid: uid(), _display: "", _art: {}, index: 0,
    name: "", sprite: "SPRITE_BEAUTY", movement: "STAY", range: "NONE",
    x: -1, y: -1, text: "", _mapId: "",
  };
}

/**
 * A TEXT constant nobody else is using.
 *
 * Naming a person after a vanilla one is easy to do by accident and quietly
 * destructive: registering `talk.TEXT_PALLETTOWN_FISHER` on a map that
 * already has a fisher rewrites what *he* says instead of giving your person
 * words. Importing one of the game's own people hits this every single time,
 * because the obvious name for a copy is the original's name.
 */
function freeTextKey(base, mine) {
  const vanilla = new Set();
  for (const m of Object.values(GAME?.npcText || {})) for (const c of Object.keys(m)) vanilla.add(c);
  let key = base;
  while (vanilla.has(key) || P.scripts.some((s) => s !== mine && s.textKey === key)) key += "_MOD";
  return key;
}

// Renaming has to move three things at once, or the person, their TEXT
// constant and the script behind it drift apart and the linter starts
// complaining about dialogue nobody wrote.
function renameNpc(n, display) {
  n._display = display;
  n.name = idFromName(display);
  const oldKey = n.text;
  const s = P.scripts.find((x) => x.textKey === oldKey);
  n.text = freeTextKey("TEXT_" + n.name, s);
  if (s) { s.textKey = n.text; s.name = display || s.name; }
  touch();
}

function npcScript(n) {
  return n.text ? P.scripts.find((s) => s.textKey === n.text) || null : null;
}

function ensureNpcScript(n) {
  let s = npcScript(n);
  if (s) return s;
  if (!n.text) n.text = freeTextKey("TEXT_" + (n.name || idFromName(npcName(n))), null);
  s = newScript(npcName(n), n._mapId || npcHome(n)?.map.id || "", "talk");
  s.textKey = n.text;
  s.nodes[0].args = { textId: "Hello there!" };
  P.scripts.push(s);
  touch();
  return s;
}

// A map record to append to: the mod's own map if it has one (committed or
// still a draft -- an NPC, a fixed encounter or an item ball can be placed
// on a map before that map itself is added), otherwise a patch of the
// vanilla map, made on demand.
function mapRecordFor(mapId) {
  return P.maps.find((m) => m.id === mapId) || P.mapDrafts.find((m) => m.id === mapId) || ensureMapPatch(mapId);
}

/**
 * Put an NPC on a map, moving them off whichever map they were on.
 *
 * This is the moment a draft stops being a draft: until an NPC has somewhere
 * to stand there is nothing to append them to, so they are held aside rather
 * than written into a map record that would export a person at cell -1,-1.
 */
function placeNpc(n, mapId, x, y) {
  const home = npcHome(n);
  if (home && home.map.id !== mapId) {
    home.map.rec.objects.splice(home.i, 1);
  }

  n.x = x; n.y = y;
  n._mapId = mapId;
  if (!mapId) return null;

  const target = mapRecordFor(mapId);
  if (!target) { toast("Load game data before placing someone", true); return null; }

  if (!target.rec.objects.includes(n)) {
    // Vanilla object indices are single digits; start well clear of them so
    // save keys like "<mapId>_obj_<index>" never collide.
    const used = new Set(target.rec.objects.map((o) => o.index));
    let index = 90;
    while (used.has(index)) index++;
    n.index = index;
    target.rec.objects.push(n);
  }

  const s = npcScript(n);
  if (s) s.mapId = mapId;
  if (P.npcDraft === n) { P.npcDraft = null; P.sel.npc = n._uid; }
  touch();
  return target;
}

function deleteNpc(n) {
  if (!confirm(`Delete ${npcName(n)}?`)) return;
  const home = npcHome(n);
  if (home) home.map.rec.objects.splice(home.i, 1);
  if (P.npcDraft === n) P.npcDraft = null;
  const s = npcScript(n);
  if (s && confirm(`Also delete their dialogue script "${s.name}"?`)) {
    P.scripts = P.scripts.filter((x) => x.uid !== s.uid);
    if (P.sel.script === s.uid) { P.sel.script = null; P.sel.node = null; }
  }
  if (n.trainerClass && isOwnTrainer(n.trainerClass) && confirm(`Also delete the trainer record "${n.trainerClass}" this made for them?`)) {
    P.entries = P.entries.filter((e) => !(e.registry === "trainers" && e.id === n.trainerClass));
  }
  P.sel.npc = null;
  touch();
  renderAll();
}

function selectNpc(n) {
  P.sel.npc = isDraft(n) ? "draft" : n._uid;
  const s = npcScript(n);
  if (s) { P.sel.script = s.uid; P.sel.node = s.start; }
  renderNpcTab();
}

/* --------------------------------------------------------- custom sprites -- */

// A custom overworld sheet is a real content record, not a preview: the mod
// ships the PNG and registers a sprite id for it, which is what lets the
// engine draw someone the game has never seen.
function customSpriteId(n) {
  const base = "SPRITE_" + (n.name || idFromName(npcName(n)));
  return GAME?.spriteSheets?.[base] ? base + "_MOD" : base;
}

function customSpriteRecords() {
  const out = [];
  for (const { npc: n } of allNpcs()) {
    const a = n._art?.overworld;
    if (a?.source !== "custom") continue;
    // anchorX/anchorY say where the art meets the tile it stands on. They
    // only matter once a frame stops being 16x16 -- a taller sprite drawn
    // without them sinks into the ground -- so they ship whenever the studio
    // worked them out, which is centred on the bottom edge.
    const data = {
      image: a.file, frames: a.frames, walker: !!a.walker,
      frameWidth: a.frameW, frameHeight: a.frameH,
    };
    if (a.anchorX !== undefined) data.anchorX = a.anchorX;
    if (a.anchorY !== undefined) data.anchorY = a.anchorY;
    if (a.trueColor) data.trueColor = true;
    out.push({ id: n.sprite, data });
  }
  return out;
}

function customArtFiles() {
  const out = [];
  const seen = new Set();
  for (const { npc: n } of allNpcs()) {
    const a = n._art?.overworld;
    if (a?.source !== "custom" || seen.has(a.file)) continue;
    seen.add(a.file);
    out.push({ name: a.file, bytes: base64Bytes(a.png) });
  }
  return out;
}

function base64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------------------------------------------------------------- steps -- */

function npcStep(host, n, title, note) {
  const wrap = el("div", { class: "step" + (n === null ? " todo" : "") });
  wrap.append(el("h3", {},
    el("span", { class: "n" }, n === null ? "—" : n + "."),
    title,
    note ? el("span", { class: "said" }, note) : null));
  const body = el("div", { class: "body" });
  wrap.append(body);
  host.append(wrap);
  return body;
}

function renderNpcTab() {
  const host = $("#npcSteps");
  if (!host) return;
  host.textContent = "";

  const n = curNpc();
  $("#npcTitle").innerHTML = n
    ? "NPC <b>" + escapeText(npcName(n)) + "</b>" + (isDraft(n) ? " — not added yet" : "")
    : "NPC";

  npcBar(host, n);
  if (!n) {
    host.append(el("div", { class: "step" },
      el("div", { class: "empty" },
        allNpcs().length
          ? "Pick someone from the list above, or press New."
          : "Nobody in this mod yet. Press New to invent one, or Import to take one of the game's own apart.")));
    renderNpcNodes(null);
    return;
  }

  syncNpcBattle(n);
  stepName(host, n);
  stepSprite(host, n);
  stepLocation(host, n);
  stepMovement(host, n);
  stepDialogue(host, n);
  stepFooter(host, n);

  renderNpcNodes(n);
}

const escapeText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function guardNpcDraft(proceed) {
  guardDraftReplace(P.npcDraft,
    { label: "“" + npcName(P.npcDraft) + "”", why: P.npcDraft && npcDraftBlocker(P.npcDraft), add: () => addNpcDraft(P.npcDraft) },
    proceed);
}

function startNewNpc() {
  P.npcDraft = blankNpc();
  P.sel.npc = "draft";
  P.sel.script = null;
  P.sel.node = null;
  touch();
  renderNpcTab();
}

function npcBar(host, cur) {
  const bar = el("div", { class: "workbar" });
  bar.append(el("button", { class: "fixed", onclick: () => guardNpcDraft(importNpcDialog) }, "Import"));
  bar.append(el("button", { class: "fixed", onclick: () => guardNpcDraft(startNewNpc) }, "New"));

  const rows = allNpcs();
  if (rows.length || P.npcDraft) {
    const sel = el("select", {
      onchange: (e) => {
        const v = e.target.value;
        if (!v) { P.sel.npc = null; renderNpcTab(); return; }
        selectNpc(v === "draft" ? P.npcDraft : rows.find((r) => r.npc._uid === v).npc);
      },
    },
      el("option", { value: "" }, `— ${rows.length} in this mod —`),
      P.npcDraft ? el("option", { value: "draft", selected: cur === P.npcDraft },
        (npcName(P.npcDraft) === "(unnamed)" ? "new person" : npcName(P.npcDraft)) + "  (not added yet)") : null,
      ...rows.map((r) => el("option", { value: r.npc._uid, selected: r.npc === cur },
        npcName(r.npc) + "  —  " + r.map.id)));
    bar.append(sel);
  }

  // Adding the draft and throwing it away are what somebody is reaching for
  // once they have stopped filling steps in, and the bar is the one part of
  // this tab that does not scroll away -- so they live here rather than at
  // the bottom of a long form. Centred between the list and Discard, with
  // Discard hard right: the two are far enough apart to not be mistaken for
  // each other on a phone.
  if (isDraft(cur)) {
    const why = npcDraftBlocker(cur);
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", {
      id: "npcAddDraft", class: "primary fixed", disabled: !!why, title: why || "",
      onclick: () => addNpcDraft(cur),
    }, "Add to the mod"));
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => discardNpcDraft(cur) }, "Discard"));
  } else if (cur) {
    // Same spot "Add to the mod" sat in before it was added -- a quiet pulse
    // once editing pauses (flashUpdated, driven by touch()'s own debounce),
    // not a button, since edits already apply live and autosave as they're
    // made and there is nothing here to actually commit.
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("span", { id: "npcUpdated", class: "updated-flash" }, "Updated"));
    // Same top-right spot a draft's Discard sits in, so deleting someone
    // already in the mod doesn't mean scrolling to the bottom of a long form.
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => deleteNpc(cur) }, "Delete this person"));
  }

  host.append(bar);
}

/**
 * Why this draft cannot be added yet, or null when it can.
 *
 * Both the bar's button and the last step read this, so the button being
 * greyed out and the sentence saying why can never disagree.
 */
function npcDraftBlocker(n) {
  return !n._display ? "Give them a name first."
    : !n._mapId ? "Pick a map in step 3."
    : n.x < 0 ? "Tap the map in step 3 to choose a spot."
    : null;
}

/**
 * Push the name they are still typing at "Add to the mod"'s disabled state
 * and tooltip. Redrawing the tab on every keystroke would take the cursor
 * out of the field they are typing in, so this is the one thing that can
 * change mid-word without a full re-render.
 */
function syncNpcDraftReady(n) {
  if (!isDraft(n)) return;
  const why = npcDraftBlocker(n);
  const b = $("#npcAddDraft");
  if (b) { b.disabled = !!why; b.title = why || ""; }
}

function addNpcDraft(n) {
  ensureNpcScript(n);
  placeNpc(n, n._mapId, n.x, n.y);
  renderAll();
  showContentSub("npc");
  toast(`${npcName(n)} is in ${n._mapId}`);
}

function discardNpcDraft(n) {
  if (!confirm("Throw this one away?")) return;
  const s = npcScript(n);
  if (s) P.scripts = P.scripts.filter((x) => x.uid !== s.uid);
  if (n.trainerClass && isOwnTrainer(n.trainerClass)) {
    P.entries = P.entries.filter((e) => !(e.registry === "trainers" && e.id === n.trainerClass));
  }
  P.npcDraft = null; P.sel.npc = null;
  touch(); renderNpcTab();
}

/* --------------------------------------------------------------- 1. name -- */

function stepName(host, n) {
  const body = npcStep(host, 1, "NPC Name");
  const idLine = el("div", { class: "hint" });
  body.append(el("input", {
    value: n._display || "", placeholder: "e.g. Old Fisherman",
    oninput: (e) => {
      renameNpc(n, e.target.value);
      idLine.textContent = line();
      syncNpcDraftReady(n);
      $("#npcTitle").innerHTML = "NPC <b>" + escapeText(npcName(n)) + "</b>" + (isDraft(n) ? " — not added yet" : "");
    },
  }));
  const line = () => n._display
    ? `The engine will know them as ${n.name}, and their dialogue as ${n.text}.`
    : "A name for you and for the mod's code — the player never sees it.";
  idLine.textContent = line();
  body.append(idLine);
}

/* ------------------------------------------------------------- 2. sprite -- */

function stepSprite(host, n) {
  const body = npcStep(host, 2, "NPC Sprite");
  const ow = overworldArt(n);

  artSlot(body, {
    title: "Overworld sprite",
    hint: "The one that actually walks around the map. Every NPC needs this one.",
    art: ow,
    label: n._art?.overworld?.source === "custom" ? n.sprite + "  (yours)" : n.sprite || "— none —",
    noThumb: true,
    onPickGame: () => pickOverworldDialog(n),
    onExport: () => exportArt(ow, (n.sprite || "overworld").toLowerCase()),
    onImport: () => spriteStudio({
      title: "Import an overworld sprite sheet",
      mode: "strip",
      fileBase: (n.name || "npc").toLowerCase() + "_overworld",
      hint: "Any sheet, any layout — a grid, a packed atlas, a single row. Pick the file and Oak's Lab finds "
        + "the frames, then you say which is which. It ships re-packed into the strip the engine reads, so "
        + "the file you start from does not have to look like anything in particular.",
      onDone: (art) => {
        n.sprite = customSpriteId(n);
        (n._art ||= {}).overworld = {
          source: "custom", ...art,
          file: "art/" + (n.name || "npc").toLowerCase() + "_overworld.png",
        };
        touch();
        renderNpcTab();
      },
    }),
    onClear: n._art?.overworld?.source === "custom" ? () => {
      delete n._art.overworld;
      n.sprite = "SPRITE_BEAUTY";
      touch(); renderNpcTab();
    } : null,
  });

  if (ow) body.append(owPreview(ow));

  body.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:14px 0" }));

  artSlot(body, {
    title: "Facing sprite",
    hint: "The bigger picture the player sees when this person faces them in battle. Only trainers use it.",
    art: facingArt(n),
    label: n._art?.facing
      ? (n._art.facing.source === "custom" ? "imported" : n._art.facing.id)
      : "— none —",
    scale: 1,
    onPickGame: () => pickPicDialog(n, "facing", "facingPics", "Pick a facing sprite"),
    onExport: () => exportArt(facingArt(n), (n._art?.facing?.id || idFromName(npcName(n)) + "_facing").toLowerCase()),
    onImport: () => spriteStudio({
      title: "Import a facing sprite",
      mode: "single",
      battle: "facing",
      who: npcName(n),
      fileBase: (n.name || "npc").toLowerCase() + "_facing",
      hint: "One picture, drawn facing the player. The game's own are 56 px square, but any size works — "
        + "drag a box on the sheet to crop out just the part you want.",
      onDone: (art) => { (n._art ||= {}).facing = { source: "custom", ...art }; touch(); renderNpcTab(); },
    }),
    onClear: n._art?.facing ? () => { delete n._art.facing; touch(); renderNpcTab(); } : null,
  });

  artSlot(body, {
    title: "Back sprite",
    hint: "Seen from behind, over the player's shoulder. Almost nothing in Gen 1 has one.",
    art: backArt(n),
    label: n._art?.back
      ? (n._art.back.source === "custom" ? "imported" : n._art.back.id)
      : "— none —",
    scale: 2,
    onPickGame: () => pickPicDialog(n, "back", "backPics", "Pick a back sprite"),
    onExport: () => exportArt(backArt(n), (n._art?.back?.id || idFromName(npcName(n)) + "_back").toLowerCase()),
    onImport: () => spriteStudio({
      title: "Import a back sprite",
      mode: "single",
      battle: "back",
      who: npcName(n),
      fileBase: (n.name || "npc").toLowerCase() + "_back",
      hint: "One picture, drawn from behind. The game's own are 32 px square, but any size works — "
        + "drag a box on the sheet to crop out just the part you want.",
      onDone: (art) => { (n._art ||= {}).back = { source: "custom", ...art }; touch(); renderNpcTab(); },
    }),
    onClear: n._art?.back ? () => { delete n._art.back; touch(); renderNpcTab(); } : null,
  });

  const bf = facingArt(n), bb = backArt(n);
  if (bf || bb) {
    body.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:14px 0" }));
    body.append(el("div", { class: "who" }, "In a battle"));
    body.append(el("p", { class: "hint" },
      "Both pictures on the screen they end up on, at the size, place and colours the engine draws "
      + "them in. The dashed box is a slot with nothing in it yet, and Palette is which of the ROM's "
      + "colourings the picture is baked through in a battle."));
    body.append(battleMockPanel({ facing: bf, back: bb, name: npcName(n), scale: 2 }));
  }

  body.append(el("p", { class: "hint warn", style: "margin-top:12px" },
    "The overworld sprite exports: an imported sheet ships as a PNG in the zip with a "
    + "sprites:register beside it. Facing and back are kept and previewed here, but they belong to "
    + "the trainer record — they start exporting when this person can be battled."));
}

// `o.noThumb` skips the little static thumbnail box -- the overworld slot
// has its own preview (owPreview, with turn arrows) right underneath, and
// showing the same sprite twice was just clutter, not two different views.
function artSlot(host, o) {
  const row = el("div", { class: "artrow" });
  if (!o.noThumb) {
    const box = el("div", { class: "artbox" });
    const thumb = o.art ? spriteThumb(o.art, o.scale) : null;
    box.append(thumb || el("div", { class: "none" }, GAME ? "none" : "no game data"));
    row.append(box);
  }

  const meta = el("div", { class: "artmeta" });
  meta.append(el("div", { class: "who" }, o.title));
  meta.append(el("div", { class: "hint" }, o.hint));
  meta.append(el("div", { class: "who", style: "color:var(--dim);margin-bottom:6px" }, o.label));
  meta.append(el("div", { class: "artbtns" },
    el("button", { onclick: o.onPickGame }, "Select sprite"),
    el("button", { onclick: o.onImport }, "Import custom sprite sheet"),
    o.art && o.onExport ? el("button", { onclick: o.onExport }, "Export") : null,
    o.onClear ? el("button", { class: "danger", onclick: o.onClear }, "Clear") : null));
  row.append(meta);
  host.append(row);
}

function pickOverworldDialog(n) {
  const sheets = GAME?.spriteSheets || {};
  const list = GAME?.ids?.sprites || Object.keys(sheets).map((id) => ({ id, name: id }));
  if (!list.length) { toast("Load game data to pick from the game's sprites", true); return; }

  const body = el("div", {});
  const grid = el("div", { class: "spritegrid" });
  const fill = (needle) => {
    grid.textContent = "";
    for (const o of list) {
      if (needle && !o.id.toLowerCase().includes(needle)) continue;
      const sheet = sheets[o.id];
      const cell = el("div", {
        class: "spritepick" + (o.id === n.sprite ? " sel" : ""),
        onclick: () => {
          n.sprite = o.id;
          if (n._art?.overworld?.source === "custom") delete n._art.overworld;
          touch();
          closeDialog();
          renderNpcTab();
        },
      });
      if (sheet) cell.append(artCanvas("game:" + o.id, sheet.png, 0, 0, FRAME_PX, FRAME_PX, 2));
      cell.append(el("span", {}, o.id.replace(/^SPRITE_/, "")));
      grid.append(cell);
    }
    if (!grid.children.length) grid.append(el("div", { class: "empty" }, "nothing matches"));
  };

  body.append(el("input", {
    type: "search", placeholder: `search ${list.length} sprites…`,
    oninput: (e) => fill(e.target.value.trim().toLowerCase()),
  }));
  body.append(el("p", { class: "hint" },
    Object.keys(sheets).length
      ? "These are the game's own sheets, drawn from your ROM cache."
      : "No pictures in this game data — regenerate it with tools/extract-gamedata.mjs to see them."));
  fill("");
  body.append(grid);
  dialog("Pick an overworld sprite", body);
}

function pickPicDialog(n, slot, bank, title) {
  const pics = GAME?.[bank] || {};
  const ids = Object.keys(pics).sort();
  if (!ids.length) { toast("No pictures in this game data — regenerate it", true); return; }

  const body = el("div", {});
  const grid = el("div", { class: "spritegrid" });
  const fill = (needle) => {
    grid.textContent = "";
    for (const id of ids) {
      if (needle && !id.includes(needle)) continue;
      const p = pics[id];
      grid.append(el("div", {
        class: "spritepick" + (n._art?.[slot]?.id === id ? " sel" : ""),
        onclick: () => {
          (n._art ||= {})[slot] = { source: "game", id };
          touch(); closeDialog(); renderNpcTab();
        },
      },
        artCanvas(bank + ":" + id, p.png, 0, 0, p.w, p.h, 1),
        el("span", {}, id)));
    }
    if (!grid.children.length) grid.append(el("div", { class: "empty" }, "nothing matches"));
  };
  if (ids.length > 12) {
    body.append(el("input", {
      type: "search", placeholder: `search ${ids.length}…`,
      oninput: (e) => fill(e.target.value.trim().toLowerCase()),
    }));
  }
  fill("");
  body.append(grid);
  dialog(title, body);
}

/* ----------------------------------------------------------- 3. location -- */

function stepLocation(host, n) {
  const home = npcHome(n);
  const mapId = n._mapId || home?.map.id || "";
  const body = npcStep(host, 3, "Location",
    home ? "on " + mapId : mapId ? "will stand in " + mapId : "not placed yet");

  body.append(el("label", {}, "Which map"));
  body.append(refSelect("maps", () => mapId, (v) => {
    n._mapId = v;
    // Someone already in the mod moves as soon as you say so; a draft is only
    // noting an answer down, and is not appended to anything until the last
    // step, so "Discard" stays a real way out right up to the end.
    if (home && v && v !== home.map.id) placeNpc(n, v, n.x < 0 ? 0 : n.x, n.y < 0 ? 0 : n.y);
    else if (!v && home) { home.map.rec.objects.splice(home.i, 1); n._mapId = ""; touch(); }
    renderNpcTab();
  }, { blank: "— pick a map —" }));

  if (!mapId) {
    body.append(el("p", { class: "hint" }, "Pick the map they stand on, then tap the spot."));
    return;
  }

  const target = mapId;
  const marker = { x: n.x, y: n.y };
  body.append(el("div", { style: "margin:10px 0;overflow:auto" },
    miniMap(target, marker, (cx, cy) => {
      if (home) placeNpc(n, target, cx, cy);
      else { n.x = cx; n.y = cy; touch(); }
      renderNpcTab();
    })));

  body.append(el("p", { class: "hint" },
    n.x < 0 ? "Tap the map to place them. Red squares are cells the player cannot walk on."
            : `Standing at cell ${n.x}, ${n.y}.`));

  if (GAME?.maps?.[target]) {
    body.append(el("p", { class: "hint warn" },
      `${target} is one of the game's own maps. Your person is appended to it, so nothing vanilla is `
      + "removed — and turning your mod off puts the map back exactly as it was."));
  }
}

/* ----------------------------------------------------------- 4. movement -- */

function stepMovement(host, n) {
  const body = npcStep(host, 4, "Movement");
  body.append(el("label", {}, "Do they move?"));
  body.append(el("select", { onchange: (e) => { n.movement = e.target.value; touch(); renderMapCanvas?.(); } },
    ...[["STAY", "Stands still"], ["WALK", "Wanders around"]]
      .map(([v, t]) => el("option", { value: v, selected: n.movement === v }, t))));

  body.append(el("label", {}, "Facing / roaming"));
  body.append(el("select", { onchange: (e) => { n.range = e.target.value; touch(); } },
    ...[["NONE", "faces down, never turns"], ["DOWN", "faces down"], ["UP", "faces up"],
        ["LEFT", "faces left"], ["RIGHT", "faces right"], ["ANY_DIR", "roams any direction"],
        ["UP_DOWN", "roams up and down"], ["LEFT_RIGHT", "roams left and right"]]
      .map(([v, t]) => el("option", { value: v, selected: n.range === v }, t))));

  const ow = overworldArt(n);
  if (n.movement === "WALK" && ow && ow.walker === false) {
    body.append(el("p", { class: "hint warn" },
      `${n.sprite} has no walking frames, so it will slide rather than walk. Pick a sprite marked as a walker, or have them stand still.`));
  }
}

/* ------------------------------------------------------ battle & teams -- */

/*
   Mod NPCs are not vanilla NPCs, and that is fine -- they do not need to be
   built from the same internal machinery to behave the same way at the table.
   A vanilla trainer's before/on-defeat/after switch is free, paid for by a
   trainer header the mod API does not expose (checked: no `trainer_headers`
   registry, and `field` does not carry it either). A mod-authored trainer
   gets the same switch the honest way instead -- an ordinary check_flag block,
   branching to an ordinary set_flag block -- using nothing but the blocks
   already on the canvas. There is no dedicated "trainer" block; a trainer is
   just a "Start a battle" block, same as any other, wired however you like.

   The one piece of this that gets help is the party. Neither the trainers
   registry nor give_pokemon has a moves field anywhere -- the engine derives
   a Pokemon's moves from its species' own learnset at that level, so there is
   nothing to author there. Species and level is the whole of it, and that is
   what the Pokemon-team block is for: an optional, visual way to build a
   party as nodes -- a "Start a battle" block's team arrow, a Pokemon team
   block with up to six numbered arrows, and a Pokemon block on each one --
   instead of typing a trainers-registry id into a text field.
*/

function isOwnTrainer(id) {
  return P.entries.some((e) => e.registry === "trainers" && e.verb === "register" && e.id === id);
}

function freeTrainerId(base) {
  const taken = new Set((GAME?.ids?.trainers || []).map((o) => o.id));
  for (const e of P.entries) if (e.registry === "trainers" && e.id) taken.add(e.id);
  let id = base, i = 2;
  while (taken.has(id)) id = base + "_" + i++;
  return id;
}

function makeOwnTrainer(n, party) {
  const id = freeTrainerId("OPP_" + (n?.name || idFromName(npcName(n || {}))));
  P.entries.push({
    uid: uid(), registry: "trainers", verb: "register", id,
    data: {
      id, name: (n?._display || id).toUpperCase(),
      parties: [party?.length ? party : [{ species: "RATTATA", level: 5 }]],
    },
  });
  return id;
}

function newTeamNode(x, y, mons) {
  return { uid: uid(), verb: "__team", args: { mons: mons || [] }, x, y, next: null, no: null };
}

// Which person a script belongs to -- needed to name a fresh trainer after
// them when a "Start a battle" block gets a team but no trainer picked yet.
function npcForScript(s) {
  if (!s) return null;
  if (P.npcDraft && P.npcDraft.text === s.textKey) return P.npcDraft;
  return allNpcs().find((r) => r.npc.text === s.textKey)?.npc || null;
}

/**
 * Fold a connected Pokemon team into the trainer it belongs to.
 *
 * Runs before every compile, so editing Pokemon on the canvas is enough --
 * nothing separate needs pressing. Only touches a trainer this mod made
 * (`isOwnTrainer`): a "Start a battle" block can still point straight at one
 * of the game's own trainers with no team connected at all, and connecting a
 * team to one of those is left alone rather than silently overwriting shared
 * vanilla data.
 */
function syncBattleTeams(s) {
  if (!s) return;
  const npc = npcForScript(s);
  for (const n of s.nodes) {
    if (n.verb !== "start_battle" || n.args?.kind !== "trainer" || !n.team) continue;
    const team = nodeById(s, n.team);
    if (!team) continue;
    const party = (team.args?.mons || [])
      .filter((m) => m.species)
      .map((m) => ({ species: m.species, level: m.level || 5 }));

    if (!n.args.who) n.args.who = makeOwnTrainer(npc, party);
    n.args.levelOrParty = 1;

    // An empty table is likely mid-edit, not "delete the party" -- leave
    // whatever the trainer record already has rather than blanking it.
    if (isOwnTrainer(n.args.who) && party.length) {
      const entry = P.entries.find((e) => e.registry === "trainers" && e.id === n.args.who);
      if (entry) entry.data.parties[0] = party;
    }
  }
}

// The map object's trainer fields are exported straight from whatever the
// graph currently says, the same way its dialogue is: there is no separate
// "is this a trainer" switch to keep in sync, only a graph to read.
function syncNpcBattle(npc) {
  const s = npcScript(npc);
  const battle = s?.nodes.find((n) => n.verb === "start_battle" && n.args?.kind === "trainer" && n.args?.who);
  if (battle) {
    npc.trainerClass = battle.args.who;
    npc.trainerParty = battle.args.levelOrParty || 1;
  } else if (npc.trainerClass !== undefined || npc.trainerParty !== undefined) {
    delete npc.trainerClass;
    delete npc.trainerParty;
  }
}

function syncAllNpcBattles() {
  for (const r of allNpcs()) syncNpcBattle(r.npc);
  if (P.npcDraft) syncNpcBattle(P.npcDraft);
}

// Both node editors draw the same graph, and a battle edit changes the NPC
// object too, so a change from either one refreshes whatever is on screen.
function refreshNodeEditors() {
  if ($("#sub-npc")?.classList.contains("on") && $("#tab-content")?.classList.contains("on")) renderNpcTab();
  else { renderNodes(SCRIPT_SURFACE); renderInspector(SCRIPT_SURFACE); }
}

// A small custom editor for the real start_battle verb -- not a Oak's Lab
// block, just a hint added alongside its normal fields about the team arrow.
NODE_EDITORS.start_battle = (host, node, surface, opts) => {
  const args = (node.args ||= {});
  for (const a of CMD.start_battle.args) {
    renderField(host, a.name, a.type, () => args[a.name] ?? a.default ?? "",
      (v) => { args[a.name] = v; renderNodes(surface); },
      { label: a.label || a.name, onChange: () => renderNodes(surface), rerender: () => renderInspector(surface, opts) });
  }
  if (args.kind !== "trainer") return;
  host.append(el("p", { class: "hint" }, node.team
    ? "A Pokemon team is connected off its right edge — its Pokemon become this trainer's party, and "
      + "“Trainer” above is kept in sync with it on every export."
    : "Pick an existing trainer above, or connect a “Pokemon team” block off the right edge's team arrow "
      + "to build one from nodes instead."));
};

// Set flag gets one extra line the generic args form wouldn't otherwise say:
// this is the same shared namespace every check_flag anywhere reads, so it
// is worth naming like a story beat rather than a throwaway switch.
NODE_EDITORS.set_flag = (host, node, surface, opts) => {
  const args = (node.args ||= {});
  for (const a of CMD.set_flag.args) {
    renderField(host, a.name, a.type, () => args[a.name] ?? a.default ?? "",
      (v) => { args[a.name] = v; renderNodes(surface); },
      { label: a.label || a.name, onChange: () => renderNodes(surface), rerender: () => renderInspector(surface, opts) });
  }
  host.append(el("p", { class: "hint warn" },
    "Flags are global — one shared story-flag namespace read by every check_flag on every map, not scoped "
    + "to this NPC or this script. That makes a flag a good way to track story/quest progress (e.g. "
    + "BEAT_COOL_TRAINER_M1), as long as the name is unique to what it means — two unrelated events sharing "
    + "a name will read each other's state."));
};

// The six rows themselves are edited right on the block (teamRows, in
// script.js's renderNodes) -- there is nothing left for the side inspector
// to do for this verb but say so and leave the "Goes to" / "This block"
// sections below (Start here, Delete) to render as normal.
NODE_EDITORS.__team = (host) => {
  host.append(el("p", { class: "hint" },
    "Up to six, edited on the block itself. Leave a row blank to skip it. Moves come from the engine's own "
    + "learnset for the species at this level — there is no way to set a custom moveset per trainer."));
};

/* ---------------------------------------------------------- 5. behaviour -- */

// What this person says and does is just the graph -- there is no separate
// declaration of who they are. Whether they battle is read straight off it
// (syncNpcBattle, called before this step draws), by looking for a "Start a
// battle" block rather than asking a form to agree with the canvas.
function stepDialogue(host, n) {
  const s = npcScript(n);
  const body = npcStep(host, 5, "What they say and do",
    n.trainerClass ? "battles as " + n.trainerClass : s ? "just talks" : "no script yet");

  if (!s) {
    body.append(el("p", { class: "hint" },
      "Nothing yet. Give them a script and it opens in the node editor below — talking is only the default "
      + "start; check a flag, give an item, start a battle, whatever this person should actually do first."));
    body.append(el("button", { class: "primary", onclick: () => {
      ensureNpcScript(n);
      selectNpc(n);
    } }, "New Behavior"));
    return;
  }

  body.append(el("p", { class: "hint" },
    "Edited in the node editor docked below — drag its orange bar up for more room, or right-click the "
    + `canvas to add a block. The rows it compiles to ship as ${s.textKey}. Any block can be where the `
    + "graph begins, not just the one it started with — select it and press “Start here” (most blocks can; "
    + "the one exception is a Pokemon team block, which is data another block reads, not a step of its own)."));

  if (n.trainerClass) {
    body.append(el("p", { class: "hint" },
      "They battle because a “Start a battle” block is somewhere in their graph. To make them fight only "
      + "once, wire a “Is flag set?” block in front of it and a “Set flag” block after — the node search "
      + "(right-click the canvas) finds both. To stop them fighting at all, delete the battle block."));
  }

  if (n._from) {
    body.append(el("p", { class: "hint" },
      `Taken from ${n._from.mapId}'s ${n._from.textKey}.`
      + (n._from.asm ? " The original also ran logic the game wrote in assembly; only its words came across." : "")));
  }

  const rows = compileScript(s);
  body.append(el("div", { class: "row" },
    el("span", { class: "hint", style: "flex:1" }, `${s.nodes.length} block(s), ${rows.rows.length} row(s)`),
    el("button", { class: "fixed", onclick: jumpToNpcNodeEditor }, "Jump to the node editor")));
}

// The docked editor already shows this person's script -- it always has,
// since renderNpcNodes reads npcScript(n) on every draw. What this button
// used to do instead was leave the workspace for the separate Scripts tab,
// which is the opposite of the point: everything about a person stays on
// one screen. So it opens the dock if it is collapsed and scrolls to it.
function jumpToNpcNodeEditor() {
  if (dockPx < 40) setDock(lastDockOpen);
  $("#npcDock")?.scrollIntoView({ behavior: "smooth", block: "end" });
}

/* ------------------------------------------------------------- 6. footer -- */

function stepFooter(host, n) {
  // A draft's "add it" story is told entirely by the bar at the top of the
  // tab now (the button, greyed out with why); repeating it down here was
  // the only reason this step existed for a draft at all.
  if (isDraft(n)) return;

  const home = npcHome(n);
  const body = npcStep(host, null, "This person");
  body.append(el("p", { class: "hint" },
    home ? `Exported as object ${n.index} on ${home.map.id}.` : "Not on any map."));
}

/* ---------------------------------------------------- the docked editor -- */

function renderNpcNodes(n) {
  const stage = $("#npcNodeStage");
  if (!stage) return;
  const s = n ? npcScript(n) : null;
  if (s && P.sel.script !== s.uid) { P.sel.script = s.uid; P.sel.node ||= s.start; }

  renderPalette(NPC_SURFACE);
  if (!s) {
    $$(".node", stage).forEach((x) => x.remove());
    $("#npcWires").textContent = "";
    const host = $("#npcNodeInspector");
    host.textContent = "";
    host.append(el("div", { class: "empty" },
      n ? "No script yet — press \"Write what they say\" in step 5." : "Select someone above."));
    return;
  }
  renderNodes(NPC_SURFACE);
  renderInspector(NPC_SURFACE, { hideMeta: true });
}

// Blender's trick: the editor is not a separate screen you go to, it is a
// pane of the one you are on, and you decide how much of the screen it gets.
let dockWant = 280;              // what the user dragged it to
let dockPx = 280;                // what fits on screen right now
let lastDockOpen = 280;          // remembered height to restore on un-collapse

// The height that fits is only knowable while the tab is on screen, and this
// gets wired before it ever is -- so the number the user chose is remembered
// separately from the number currently applied, and re-clamped on every draw.
function setDock(px) {
  const frame = $("#npcDock");
  if (!frame) return;
  dockWant = Math.max(0, px);
  const h = frame.clientHeight;
  dockPx = h > 240 ? Math.min(dockWant, h - 140) : dockWant;
  frame.style.setProperty("--dock", dockPx + "px");
  const btn = $("#npcDockToggle");
  if (btn) btn.textContent = dockPx < 40 ? "▴" : "▾";
  Store.set("modforge.dock", String(dockWant));
}

function wireNpcDock() {
  const bar = $("#npcDockBar");
  const frame = $("#npcDock");
  if (!bar || !frame) return;

  const saved = Number(Store.get("modforge.dock"));
  setDock(Number.isFinite(saved) && saved > 0 ? saved : 280);

  addEventListener("resize", () => setDock(dockWant));

  let drag = null;
  bar.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    ev.preventDefault();
    drag = { y: ev.clientY, from: dockPx };
    bar.setPointerCapture(ev.pointerId);
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    setDock(drag.from + (drag.y - ev.clientY));       // drag up, grow down
  });
  const end = () => { drag = null; };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);

  // A collapsed dock remembers how tall it was, so getting it back is one tap.
  $("#npcDockToggle").onclick = () => {
    if (dockPx < 40) setDock(lastDockOpen);
    else { lastDockOpen = dockPx; setDock(0); }
  };

  wireCanvas(NPC_SURFACE);
  $("#npcAllVerbs").onchange = () => renderPalette(NPC_SURFACE);
}

/* -------------------------------------------------- importing from the game -- */

// Control codes, straight out of the ROM's text encoding: \012 starts a fresh
// text box, \011 scrolls to the next line inside the one already open. The
// first is a new node; the second is just a newline.
const TEXT_NEWBOX = "\f";
const TEXT_CONT = "\v";

function vanillaLines(raw) {
  return String(raw || "")
    .split(TEXT_NEWBOX)
    .map((part) => part.split(TEXT_CONT).join("\n").replace(/\s+$/, ""))
    .filter((part) => part.length);
}

/**
 * A vanilla person's dialogue, rebuilt as a chain of nodes.
 *
 * This is the point of Import: the graph it produces is the same graph the
 * tool would have compiled from scratch, so "how does the game do it?" and
 * "how do I do it?" have visibly the same answer.
 */
/**
 * A vanilla person's dialogue, rebuilt as a graph.
 *
 * Talkers get their words from text_pointers; trainers get theirs from
 * trainer_headers, already split the same three ways this tool's trainer block
 * splits them. That is the nice part: the game's own data model and the four
 * arrows are the same shape, so an imported trainer is a worked example of the
 * thing you would have built by hand.
 */
/**
 * A vanilla person's dialogue, rebuilt as a graph of plain blocks -- no
 * special "trainer" wrapper, because there is no such thing on the canvas.
 * A talker gets their words on a chain of Say blocks. A trainer gets the
 * shape the engine's own before/on-defeat/after split actually needs, built
 * from the same blocks anyone would drop by hand:
 *
 *   [Is flag set? BEAT_X]
 *     YES ─► [Say: after]
 *     NO  ─► [Say: before] ─► [save end battle text: won] ─► [Start a battle]
 *                                                                   │ then
 *                                                          [Did player win?]
 *                                                                   │ YES
 *                                                            [Set flag BEAT_X]
 *
 * The party comes across as real Pokemon on a Pokemon-team block, copied from
 * the original trainer's party (species and level -- nothing else exists to
 * copy) onto a fresh trainer this mod owns, so the copy is fully editable and
 * the original untouched.
 */
function scriptFromVanilla(display, mapId, textKey, raw, trainer) {
  const s = newScript(display, mapId, "talk");
  s.textKey = textKey;
  s.nodes = [];

  const chain = (text, x, y) => {
    const parts = vanillaLines(text);
    if (!parts.length) return null;
    const made = parts.map((t, i) => ({
      uid: uid(), verb: "show_text", args: { textId: t },
      x, y: y + i * 120, next: null, no: null,
    }));
    for (let i = 0; i < made.length - 1; i++) made[i].next = made[i + 1].uid;
    s.nodes.push(...made);
    return made[0].uid;
  };
  const tailOf = (headUid) => {
    let n = headUid ? s.nodes.find((x) => x.uid === headUid) : null;
    const seen = new Set();
    while (n?.next && !seen.has(n.uid)) { seen.add(n.uid); n = s.nodes.find((x) => x.uid === n.next); }
    return n;
  };

  if (!trainer) {
    s.start = chain(raw, 40, 40) || chain("...", 40, 40);
    return s;
  }

  const flag = "BEAT_" + idFromName(display);
  const vanillaParty = GAME?.trainers?.[trainer.trainerClass]?.parties?.[(trainer.trainerParty || 1) - 1] || [];
  const ownId = makeOwnTrainer({ name: idFromName(display), _display: display },
    vanillaParty.map((p) => ({ species: p.species, level: p.level })));

  const team = newTeamNode(760, 40, vanillaParty.slice(0, 6).map((p) => ({ species: p.species, level: p.level })));
  s.nodes.push(team);

  const setFlag = { uid: uid(), verb: "set_flag", args: { name: flag }, x: 260, y: 780, next: null, no: null };
  const result = { uid: uid(), verb: "check_battle_result", args: { result: "win" }, x: 260, y: 660, next: setFlag.uid, no: null };
  const battle = {
    uid: uid(), verb: "start_battle", args: { kind: "trainer", who: ownId, levelOrParty: 1 },
    x: 260, y: 540, next: result.uid, no: null, team: team.uid,
  };
  s.nodes.push(result, setFlag, battle);

  let battleEntry = battle.uid;
  // The engine shows one line as they lose, so only the first survives -- the
  // rest of a multi-box `won` string would be dropped silently otherwise.
  const defeatLine = vanillaLines(trainer.won)[0];
  if (defeatLine) {
    const defeat = { uid: uid(), verb: "save_end_battle_text", args: { textId: defeatLine }, x: 260, y: 400, next: battle.uid, no: null };
    s.nodes.push(defeat);
    battleEntry = defeat.uid;
  }

  const beforeHead = chain(trainer.before, 260, 260);
  const tail = tailOf(beforeHead);
  if (tail) tail.next = battleEntry;
  const afterHead = chain(trainer.after, 40, 260);

  const check = {
    uid: uid(), verb: "check_flag", args: { name: flag }, x: 40, y: 40,
    next: afterHead, no: beforeHead || battleEntry,
  };
  s.nodes.push(check);
  s.start = check.uid;
  return s;
}

function importNpcDialog() {
  if (!GAME?.maps) { toast("Load game data first", true); return; }
  const body = el("div", {});
  const state = { mapId: "PALLET_TOWN" };
  const listHost = el("div", { style: "margin-top:8px" });

  const fill = () => {
    listHost.textContent = "";
    const src = GAME.maps[state.mapId];
    const people = src?.objects || [];
    if (!people.length) {
      listHost.append(el("div", { class: "empty" }, "No people on that map."));
      return;
    }
    for (const o of people) {
      const said = GAME.npcText?.[state.mapId]?.[o.text];
      // A trainer's words are in the header, not the text table -- looking in
      // the wrong place is what used to make them import saying "...".
      const head = o.trainerClass ? GAME.trainerText?.[state.mapId]?.[o.index] : null;
      const sheet = GAME.spriteSheets?.[o.sprite];
      const preview = head
        ? vanillaLines(head.before).join(" ").slice(0, 110)
        : said ? vanillaLines(said.text).join(" / ").slice(0, 110) : "";
      listHost.append(el("div", {
        class: "item", style: "align-items:flex-start",
        onclick: () => { closeDialog(); adoptVanilla(state.mapId, o, said, head); },
      },
        sheet ? artCanvas("game:" + o.sprite, sheet.png, 0, 0, FRAME_PX, FRAME_PX, 2) : null,
        el("div", { style: "flex:1;min-width:0" },
          el("div", {}, o.name || o.sprite, o.trainerClass ? el("span", { class: "tag", style: "margin-left:6px" }, "battles") : null),
          el("div", { class: "hint", style: "margin:2px 0 0;white-space:pre-wrap" },
            preview || (o.trainerClass ? "(no header for this one)" : "(dialogue not in this game data)")),
          el("div", { class: "hint", style: "margin:2px 0 0;color:var(--dimmer)" },
            `cell ${o.x},${o.y} · ${o.movement} · ${o.sprite}`
            + (head ? ` · spots you ${head.sight || 0} tiles away` : "")))));
    }
  };

  body.append(el("p", { class: "hint" },
    "Take one of the game's own people apart: their sprite, where they stand, how they move, and what they "
    + "say rebuilt as nodes. You get a copy to change, and the original is left alone."));
  body.append(el("label", {}, "From which map"));
  body.append(refSelect("maps", () => state.mapId, (v) => { state.mapId = v; fill(); }, { blank: "— pick a map —" }));
  fill();
  body.append(listHost);
  dialog("Import a person from the game", body);
}

function adoptVanilla(mapId, o, said, head) {
  const n = blankNpc();
  // Vanilla objects are named "<MAP>_<WHO>"; the map part is noise on a copy
  // that may well end up standing somewhere else entirely.
  const label = (GAME?.maps?.[mapId]?.label || "").toUpperCase();
  const who = String(o.name || o.sprite.replace(/^SPRITE_/, "")).replace(new RegExp("^" + label + "_?"), "");
  n._display = titleCase(who || o.sprite.replace(/^SPRITE_/, ""));
  n.name = idFromName(n._display);
  n.text = freeTextKey("TEXT_" + n.name, null);
  n.sprite = o.sprite;
  n.movement = o.movement || "STAY";
  n.range = o.range || "NONE";
  n.x = o.x; n.y = o.y;
  n._mapId = mapId;
  n._from = { mapId, textKey: o.text, asm: !!said?.asm, sight: head?.sight };

  // Trainer classes and overworld sprites share a naming root often enough
  // that guessing the facing picture is right more often than leaving it empty.
  const pic = GAME?.trainers?.[o.trainerClass]?.pic;
  const guess = (pic ? pic.replace(/^.*\//, "").replace(/\.png$/, "") : o.sprite.replace(/^SPRITE_/, "")).toLowerCase().replace(/_/g, "");
  if (GAME?.facingPics?.[guess]) n._art.facing = { source: "game", id: guess };

  P.scripts.push(scriptFromVanilla(n._display, "", n.text, said?.text,
    o.trainerClass
      ? {
        trainerClass: o.trainerClass, trainerParty: o.trainerParty || 1,
        // Gym leaders have no trainer_headers entry at all -- their whole
        // pre-battle speech is a normal text_pointers string instead, same
        // as a talker's. Erika's "Hello. Lovely weather..." lives there, not
        // in `head`, so it is the fallback for "before" specifically.
        before: head?.before || said?.text || "", won: head?.won || "", after: head?.after || "",
      }
      : null));
  P.npcDraft = n;
  P.sel.npc = "draft";
  syncNpcBattle(n);
  touch();
  selectNpc(n);
  toast(`${n._display} copied — step 3 says where they stand`);
}

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s_])(\w)/g, (m, a, b) => a.replace("_", " ") + b.toUpperCase());
