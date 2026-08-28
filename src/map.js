"use strict";
/* ============================================================================
   Oak's Lab maps — block painting, warps, signs and NPCs.

   Coordinates follow the engine: a block is 32x32 px = 4x4 tiles of 8x8, the
   `blocks` array is row-major of length width*height, and warps/signs/objects
   sit on the 16px cell grid, so a map is width*2 by height*2 cells.

   Passability is the engine's rule from src/world/Map.lua: a cell is walkable
   when its BOTTOM-LEFT 8x8 tile is in the tileset's `walkable` list.
   ========================================================================== */

const TILE = 8, BLOCK_TILES = 4, BLOCK_PX = 32, CELL_PX = 16;

// Canvas fillStyle can't parse "var(--x)" -- an unparsable value is silently
// ignored, not an error, so every marker that tried it painted with
// whatever colour a PREVIOUS fillStyle assignment happened to leave behind.
// That is why warps, signs and people used to all come out the same colour.
// Resolved once and cached: these tokens don't change without a rebuild.
const cssVarCache = new Map();
function cssVar(name) {
  if (!cssVarCache.has(name)) {
    cssVarCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }
  return cssVarCache.get(name);
}

let mapScale = 2;
let mapTool = "paint";
let selBlock = 0;
// Sub-tile mode's brush: which quarter of which block of which tileset the
// next paint stroke lays down. Null until a quarter has been clicked.
let zoneSelQuad = null;
// The Select tool's marquee, in block coords -- x0..x1 and y0..y1 INCLUSIVE,
// always normalized so x0<=x1 and y0<=y1. Null when nothing is selected.
let selectRect = null;
// While an existing selection is being dragged to a new spot: where it would
// land if dropped right now. Kept separate from selectRect so nothing is
// actually moved until the drag ends -- the drag is free to be cancelled by
// dragging back over the start, or to run off the edge and get clamped,
// without touching real block data on every pointermove.
let selectPreview = null;
const sheetCache = new Map();
// Anyone drawing from a sheet that has not finished decoding yet -- a
// mini-map most often, since the main canvas and palette already repaint
// themselves on load -- registers here to be told when it has.
const sheetWaiters = new Map();

const curMap = () => P.maps.find((m) => m.uid === P.sel.map) || P.mapDrafts.find((m) => m.uid === P.sel.map) || null;
const isMapDraft = (m) => !!m && P.mapDrafts.includes(m);

function tilesetOf(m) { return GAME?.tilesets?.[m?.rec?.tileset] || null; }

// `onReady` fires once, the first time this sheet finishes decoding after
// this call -- never if it already has, so a caller that redraws on every
// call does not loop. Miss this and a mini-map opened before its tileset's
// Image has decoded falls back to the abstract numbered-block placeholder
// and is stuck there until something else forces a redraw (previously: only
// a click on the map itself, which happens to trigger one as a side effect).
function sheetFor(tsId, onReady) {
  const cached = sheetCache.get(tsId);
  if (cached) {
    if (onReady && !(cached.complete && cached.naturalWidth)) {
      (sheetWaiters.get(tsId) || sheetWaiters.set(tsId, new Set()).get(tsId)).add(onReady);
    }
    return cached;
  }
  const ts = GAME?.tilesets?.[tsId];
  if (!ts?.png) return null;
  const img = new Image();
  const waiters = sheetWaiters.get(tsId) || sheetWaiters.set(tsId, new Set()).get(tsId);
  if (onReady) waiters.add(onReady);
  img.onload = () => {
    renderMapCanvas(); renderBlockPalette();
    for (const fn of waiters) fn();
    waiters.clear();
  };
  img.src = "data:image/png;base64," + ts.png;
  sheetCache.set(tsId, img);
  return img;
}

/* ---------------------------------------------------------- map records -- */

function newMapRecord(id, tilesetId, w, h) {
  return {
    uid: uid(), verb: "register", id, base: null, dirtyBlocks: true,
    rec: {
      id, label: id, index: 1000 + P.maps.length,
      tileset: tilesetId, width: w, height: h,
      blocks: new Array(w * h).fill(0),
      borderBlock: 0, warps: [], signs: [], objects: [], connections: {},
    },
  };
}

function mapFromVanilla(baseId) {
  const src = GAME?.maps?.[baseId];
  if (!src) return null;
  return {
    uid: uid(), verb: "patch", id: baseId, base: baseId, dirtyBlocks: false,
    rec: {
      id: baseId, label: src.label, index: src.index,
      tileset: src.tileset, width: src.width, height: src.height,
      blocks: [...src.blocks], borderBlock: src.borderBlock,
      warps: JSON.parse(JSON.stringify(src.warps)),
      signs: JSON.parse(JSON.stringify(src.signs)),
      objects: JSON.parse(JSON.stringify(src.objects)),
      connections: JSON.parse(JSON.stringify(src.connections || {})),
      // Kept so a patch can tell "mine" from "was already there".
      _vanillaCounts: { warps: src.warps.length, signs: src.signs.length, objects: src.objects.length },
      _vanillaBorderBlock: src.borderBlock,
    },
  };
}

/**
 * A full, standalone copy of a vanilla map under a new id -- unlike
 * mapFromVanilla's "patch", this ships as its own `register`ed map, so the
 * original is never touched and editing this one can never bleed back onto
 * it. The trade a patch makes (ship only what changed) does not apply: a
 * copy ships everything, because there is nothing else on the cartridge
 * naming its id.
 */
function mapCopyFromVanilla(baseId, newId) {
  const src = GAME?.maps?.[baseId];
  if (!src) return null;
  return {
    uid: uid(), verb: "register", id: newId, base: baseId, dirtyBlocks: true,
    rec: {
      id: newId, label: src.label + " copy", index: 1000 + P.maps.length,
      tileset: src.tileset, width: src.width, height: src.height,
      blocks: [...src.blocks], borderBlock: src.borderBlock,
      warps: JSON.parse(JSON.stringify(src.warps)),
      signs: JSON.parse(JSON.stringify(src.signs)),
      objects: JSON.parse(JSON.stringify(src.objects)),
      connections: JSON.parse(JSON.stringify(src.connections || {})),
    },
  };
}

/* --------------------------------------------------------------- drafts -- */

// Same idea as the NPC/Pokemon/Move/Item workspaces -- a new map is nothing
// but paint and pointer clicks until it is deliberately added, so an
// abandoned experiment never inflates "how much does this mod change"
// checks (All records doesn't list maps, but Export's content-detection and
// the Scripts tab's file preview both read P.maps directly) -- but maps are
// the one kind that can have SEVERAL drafts open at once: confirming a warp
// between two floors of the same building means being able to flip between
// both while neither is added yet, so starting a new one never has to ask
// "throw the other one away first?" the way New does on the other screens.
const mapDraftBlocker = (m) => !m.id ? "Give it an id first." : null;

const mapDraftWhyText = (why) => why
  ? why + " Until then “Add to the mod” up here stays greyed out."
  : "Ready — press “Add to the mod” up here. “Discard” beside it throws this one away.";

function syncMapDraftReady(m) {
  if (!isMapDraft(m)) return;
  const why = mapDraftBlocker(m);
  const b = $("#mapAddDraft");
  if (b) { b.disabled = !!why; b.title = why || ""; }
  const p = $("#mapDraftWhy");
  if (p) { p.className = "hint" + (why ? " warn" : ""); p.textContent = mapDraftWhyText(why); }
}

// A door back to the map this one was entered from is real content on THAT
// map too, so it waits here on the draft (as plain data, never written
// anywhere) until it is actually resolved -- mirroring how placeNpc() only
// touches a foreign map at the moment an NPC draft is finally added, never
// while it is still just being filled in. "from" can itself still be a
// draft (another floor of the same place, wired up before either ships).
function resolvePendingConnect(m) {
  const pending = m._pendingConnect;
  if (!pending) return;
  delete m._pendingConnect;
  const from = P.mapDrafts.find((x) => x.id === pending.fromMap)
    || P.maps.find((x) => x.id === pending.fromMap)
    || ensureMapPatch(pending.fromMap);
  if (!from) return;
  from.rec.warps.push({ x: pending.marker.x, y: pending.marker.y, destMap: m.id, destWarp: 1 });
  // The way back. destWarp is 1-based and counts the warps already on that
  // map, so ours is the one we just appended.
  m.rec.warps.push({
    x: Math.min(1, m.rec.width * 2 - 1), y: Math.min(1, m.rec.height * 2 - 1),
    destMap: pending.fromMap, destWarp: from.rec.warps.length,
  });
  m.entryFrom = { mapId: pending.fromMap, x: pending.marker.x, y: pending.marker.y };
}

function commitOneMapDraft(m) {
  P.mapDrafts = P.mapDrafts.filter((x) => x !== m);
  P.maps.push(m);
  resolvePendingConnect(m);
  P.sel.map = m.uid;
  P.sel.mapEnt = null;
  touch(); renderAll(); showContentSub("maps");
  toast((m.rec.label || m.id) + " added");
}

function commitAllMapDrafts() {
  const drafts = P.mapDrafts;
  P.mapDrafts = [];
  for (const m of drafts) P.maps.push(m);
  // Resolved as a second pass so a warp aimed at "whichever floor comes
  // after mine" always finds its target already moved into P.maps.
  for (const m of drafts) resolvePendingConnect(m);
  const last = drafts[drafts.length - 1];
  P.sel.map = last ? last.uid : null;
  P.sel.mapEnt = null;
  touch(); renderAll(); showContentSub("maps");
  toast(`${drafts.length} maps added`);
}

// Several floors of one place are usually meant to ship together, so adding
// one while others are still in progress asks first rather than assuming.
function addMapDraft(m) {
  if (P.mapDrafts.length <= 1) { commitOneMapDraft(m); return; }
  const body = el("div", {},
    el("p", {},
      `You have ${P.mapDrafts.length} maps in progress. Add all of them together `
      + "(useful when they warp into each other), or just this one?"),
    el("div", { class: "row", style: "margin-top:12px" },
      el("button", { class: "primary", onclick: () => { closeDialog(); commitAllMapDrafts(); } },
        `Add all ${P.mapDrafts.length}`),
      el("button", { onclick: () => { closeDialog(); commitOneMapDraft(m); } }, "Just this one"),
      el("button", { onclick: closeDialog }, "Cancel")));
  dialog("Add to the mod", body);
}

function discardMapDraft(m) {
  if (!confirm(`Throw away "${m.rec.label || m.id}"?`)) return;
  P.mapDrafts = P.mapDrafts.filter((x) => x !== m);
  if (P.sel.map === m.uid) { P.sel.map = null; P.sel.mapEnt = null; }
  touch(); renderMapTab();
}

/* ------------------------------------------------------- custom tilesets -- */

// A tileset the user imported from their own sprite sheet, merged into
// GAME.tilesets under its own id -- so the palette, the canvas and the
// export pipeline treat it exactly like a vanilla tileset and never have to
// know the difference. Idempotent and cheap, so renderAll() just calls this
// every time rather than tracking which of P/GAME changed underneath it.
function applyCustomTilesets() {
  if (!GAME) return;
  GAME.tilesets = GAME.tilesets || {};
  for (const t of P.customTilesets || []) {
    GAME.tilesets[t.id] = { png: t.png, tilesPerRow: t.tilesPerRow, blocks: t.blocks, walkable: t.walkable };
  }
}

// Slice an uploaded sheet into 32x32 blocks, left to right, top to bottom,
// with no repacking: each block's 16 tile ids point straight at its own 8x8
// squares in the sheet exactly as uploaded, so the sheet itself can be
// shipped as the tileset's PNG unchanged.
function sliceTilesetImage(img) {
  const cols = Math.floor(img.width / BLOCK_PX);
  const rows = Math.floor(img.height / BLOCK_PX);
  const tilesPerRow = Math.floor(img.width / TILE);
  const blocks = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const block = new Array(16);
      for (let ty = 0; ty < 4; ty++)
        for (let tx = 0; tx < 4; tx++)
          block[ty * 4 + tx] = (by * 4 + ty) * tilesPerRow + (bx * 4 + tx);
      blocks.push(block);
    }
  }
  return { cols, rows, tilesPerRow, blocks };
}

/**
 * The "import a sprite sheet" dialog for Blocks. Every block starts solid --
 * there is no way to infer walkability from pixels alone, and the map
 * editor's own Open up tool already exists to carve out ground once the
 * tileset is actually placed on a map.
 */
function importTilesetDialog() {
  const m = curMap();
  if (!m) { toast("Create or select a map first", true); return; }

  const body = el("div", {});
  const idField = el("input", { value: "MY_TILESET" });
  const status = el("div", { class: "hint" });
  const input = el("input", { type: "file", accept: "image/png,image/*" });
  let pending = null;

  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] || "");
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    let img;
    try { img = await imageFromB64(b64); }
    catch { toast("That file is not an image this browser can read", true); return; }
    const sliced = sliceTilesetImage(img);
    if (!sliced.cols || !sliced.rows) {
      pending = null;
      status.textContent = `${img.width}x${img.height} is smaller than one 32x32 block.`;
      return;
    }
    pending = { png: b64, ...sliced };
    const leftover = img.width % BLOCK_PX || img.height % BLOCK_PX
      ? ` ${img.width}x${img.height} doesn't divide evenly into 32px blocks; the leftover strip is dropped.` : "";
    status.textContent = `${sliced.cols * sliced.rows} block${sliced.cols * sliced.rows === 1 ? "" : "s"} `
      + `(${sliced.cols} across, ${sliced.rows} down), cut top-left to bottom-right.` + leftover;
  };

  body.append(
    el("label", {}, "Tileset id"), idField,
    el("p", { class: "hint" },
      "A PNG cut into 32x32 blocks. Every block starts solid -- use the Collision tools once it's "
      + "on the map to open up ground the player can walk on."),
    input, status);

  body.append(el("div", { class: "row", style: "margin-top:12px" },
    el("button", { class: "primary", onclick: () => {
      const id = idField.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!id) { toast("Give it an id", true); return; }
      if (GAME?.tilesets?.[id]) { toast("That id is already used", true); return; }
      if (!pending) { toast("Choose an image first", true); return; }
      P.customTilesets.push({ id, png: pending.png, tilesPerRow: pending.tilesPerRow, blocks: pending.blocks, walkable: [] });
      applyCustomTilesets();
      touch();
      closeDialog();
      zoneOf(m).paintTs = id;
      renderMapTab();
      toast(`${id} added -- select it above to paint with it`);
    } }, "Add tileset"),
    el("button", { onclick: closeDialog }, "Cancel")));

  dialog("Import a sprite sheet", body);
}

// The raw sheet for whichever tileset is currently being used to paint this
// map -- vanilla or imported, same shape either way. Unlike Zone art's
// export (the map's own re-indexed, collision-baked atlas, only present once
// a map is mixed), this is just "give me back the sheet I'm painting from."
function exportTilesetSheet() {
  const m = curMap();
  if (!m) { toast("Create or select a map first", true); return; }
  const palTs = paletteTilesetId(m);
  const ts = GAME?.tilesets?.[palTs];
  if (!ts?.png) { toast("No art to export for " + palTs, true); return; }
  download(new Blob([base64Bytes(ts.png)], { type: "image/png" }), palTs.toLowerCase() + ".png");
}

/**
 * What actually gets written to main.lua.
 *
 * A patch only ships what changed. Additions use the `__append` wrapper the
 * tutorials use so vanilla entries survive; terrain edits have to ship the
 * whole blocks array, since that is the only shape the registry takes.
 */
// The NPC workspace keeps its own answers -- which picture, imported art, the
// name a person was typed under -- on the very object it exports, so that one
// object stays the single record of a person. They are all underscored, and
// stripped here rather than in the workspace, so main.lua only ever carries
// fields the engine has a use for.
const forEngine = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith("_")) out[k] = v;
  return out;
};

function mapRecordForExport(m) {
  const r = m.rec;
  const entities = (key) => (r[key] || []).map(forEngine);
  // A map that borrowed blocks from other tilesets, mixed quadrants, or had
  // its collision painted ships its own compounded tileset and a blocks array
  // re-indexed against it -- see src/zone.js. A plain map gets back exactly
  // what it already had.
  const zone = typeof zoneExportFor === "function"
    ? zoneExportFor(m)
    : { tileset: r.tileset, blocks: r.blocks, borderBlock: r.borderBlock };

  if (m.verb === "register") {
    const out = {
      id: r.id, label: r.label, index: r.index, tileset: zone.tileset,
      width: r.width, height: r.height, blocks: zone.blocks, borderBlock: zone.borderBlock,
    };
    if (r.warps?.length) out.warps = entities("warps");
    if (r.signs?.length) out.signs = entities("signs");
    if (r.objects?.length) out.objects = entities("objects");
    if (Object.keys(r.connections || {}).length) out.connections = r.connections;
    return out;
  }

  const counts = r._vanillaCounts || { warps: 0, signs: 0, objects: 0 };
  const out = {};
  for (const key of ["warps", "signs", "objects"]) {
    const added = entities(key).slice(counts[key]);
    if (added.length) out[key] = { __append: added };
  }
  // Re-pointing a vanilla map at a compounded tileset is a terrain edit even
  // if no block index changed, so it travels with the blocks array.
  if (m.dirtyBlocks || zone.tileset !== r.tileset) {
    out.blocks = zone.blocks;
    if (zone.tileset !== r.tileset) out.tileset = zone.tileset;
  }
  // Map:blockAt (src/world/Map.lua) returns this for every out-of-bounds
  // block, so it ships whenever the user changed it OR whenever the tileset
  // itself got re-pointed -- same reasoning as blocks just above: an
  // untouched border index left unshipped would still merge onto the NEW
  // compounded tileset at runtime and point at the wrong block.
  if (r.borderBlock !== r._vanillaBorderBlock || zone.tileset !== r.tileset) {
    out.borderBlock = zone.borderBlock;
  }
  if (!Object.keys(out).length) out["--"] = "@lua:nil --[[ nothing changed yet ]]";
  return out;
}

/* ------------------------------------------------------------- geometry -- */

function tileAt(m, tx, ty) {
  const r = m.rec, ts = tilesetOf(m);
  if (!ts) return -1;
  const bx = tx >> 2, by = ty >> 2;
  if (bx < 0 || by < 0 || bx >= r.width || by >= r.height) return -1;
  const block = ts.blocks[r.blocks[by * r.width + bx]];
  if (!block) return -1;
  return block[(ty & 3) * BLOCK_TILES + (tx & 3)];
}
// The engine's rule, not a guess: bottom-left tile of the cell decides.
const cellTile = (m, cx, cy) => tileAt(m, cx * 2, cy * 2 + 1);

/**
 * Is this cell walkable?
 *
 * Delegates to the zone engine (src/zone.js), which knows about the three
 * things this plain lookup does not: a block borrowed from another tileset,
 * a block mixed from quadrants, and a painted collision override. The simple
 * path below is the fallback for a build without zone.js concatenated in.
 */
function isWalkable(m, cx, cy) {
  if (typeof zoneIsWalkable === "function") return zoneIsWalkable(m, cx, cy);
  const ts = tilesetOf(m);
  if (!ts) return true;
  return ts.walkable.includes(cellTile(m, cx, cy));
}

/* -------------------------------------------------------------- drawing -- */

/**
 * Draw a map into any canvas. Shared by the Maps tab and by the mini-maps the
 * wizards use for "tap where this goes", so the little preview is the same
 * picture as the editor rather than a second, drifting implementation.
 */
function drawMapInto(cv, m, scale, opts = {}) {
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  if (!m) { cv.width = cv.height = 1; return; }
  const r = m.rec;
  // One block deep, just to show what it looks like -- the real game
  // repeats Map:blockAt's out-of-bounds fallback forever (src/world/Map.lua).
  const MARGIN = opts.border ? BLOCK_PX : 0;
  const W = r.width * BLOCK_PX, H = r.height * BLOCK_PX;
  cv.width = (W + MARGIN * 2) * scale;
  cv.height = (H + MARGIN * 2) * scale;
  cv.style.width = ((W + MARGIN * 2) * scale) + "px";
  cv.style.height = ((H + MARGIN * 2) * scale) + "px";

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#dde3ec";
  ctx.fillRect(0, 0, W + MARGIN * 2, H + MARGIN * 2);
  const showWalk = opts.walk, showGrid = opts.grid;

  const ts = tilesetOf(m);
  const sheet = ts ? sheetFor(r.tileset, opts.onReady) : null;

  // Compound and sub-tile cells can each come from a different tileset, so
  // every sheet the map touches has to be asked for (and waited on) rather
  // than just the map's own -- otherwise a borrowed block stays a red square
  // until something unrelated forces a repaint.
  if (typeof zoneOf === "function" && ts) {
    for (const other of zoneTilesetsUsed(m)) if (other !== r.tileset) sheetFor(other, opts.onReady);
  }

  if (MARGIN && sheet?.complete && ts) {
    const borderCanvas = zoneBlockCanvas(r.tileset, r.borderBlock || 0);
    for (let by = -1; by <= r.height; by++) {
      for (let bx = -1; bx <= r.width; bx++) {
        if (bx >= 0 && bx < r.width && by >= 0 && by < r.height) continue;
        ctx.drawImage(borderCanvas, (bx + 1) * BLOCK_PX, (by + 1) * BLOCK_PX);
      }
    }
  }

  ctx.save();
  ctx.translate(MARGIN, MARGIN);

  if (sheet?.complete && ts) {
    for (let by = 0; by < r.height; by++) {
      for (let bx = 0; bx < r.width; bx++) {
        // One call covers all three shapes a cell can take: a plain block, a
        // block borrowed from another tileset, or four mixed quadrants.
        ctx.drawImage(zoneCellCanvas(m, bx, by), bx * BLOCK_PX, by * BLOCK_PX);
      }
    }
  } else {
    // No ROM data loaded: still authorable, just abstract.
    ctx.font = "8px monospace";
    for (let by = 0; by < r.height; by++) {
      for (let bx = 0; bx < r.width; bx++) {
        const v = r.blocks[by * r.width + bx];
        ctx.fillStyle = `hsl(${(v * 37) % 360} 25% ${18 + (v % 5) * 6}%)`;
        ctx.fillRect(bx * BLOCK_PX, by * BLOCK_PX, BLOCK_PX, BLOCK_PX);
        ctx.fillStyle = "#5d6e7e";
        ctx.fillText(String(v), bx * BLOCK_PX + 3, by * BLOCK_PX + 12);
      }
    }
  }

  if (showWalk && ts) {
    for (let cy = 0; cy < r.height * 2; cy++) {
      for (let cx = 0; cx < r.width * 2; cx++) {
        const forced = typeof cellSolidOf === "function" ? cellSolidOf(m, cx, cy) : null;
        if (!isWalkable(m, cx, cy)) {
          // A cell the tileset already blocks, vs one painted solid: the
          // second is the user's own decision and worth telling apart, since
          // it is the one that costs a duplicated tile in the atlas.
          ctx.fillStyle = forced === false ? "rgba(255,60,60,0.42)" : "rgba(255,60,60,0.24)";
          ctx.fillRect(cx * CELL_PX, cy * CELL_PX, CELL_PX, CELL_PX);
        } else if (forced === true) {
          ctx.fillStyle = "rgba(80,200,120,0.30)";
          ctx.fillRect(cx * CELL_PX, cy * CELL_PX, CELL_PX, CELL_PX);
        }
      }
    }
  }

  // Marked warp-trigger cells, shown regardless of showWalk -- same reasoning
  // as the warps/signs/objects markers below: this is content, not a debug
  // overlay, so it stays visible while placing or checking a door.
  if (ts && typeof cellWarpTileOf === "function") {
    for (let cy = 0; cy < r.height * 2; cy++) {
      for (let cx = 0; cx < r.width * 2; cx++) {
        if (!cellWarpTileOf(m, cx, cy)) continue;
        ctx.strokeStyle = "rgba(180,80,220,0.9)";
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(cx * CELL_PX + 1, cy * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
      }
    }
  }

  if (showGrid) {
    ctx.strokeStyle = "rgba(155,188,15,0.18)";
    ctx.lineWidth = 1 / scale;
    for (let cx = 0; cx <= r.width * 2; cx++) {
      ctx.beginPath(); ctx.moveTo(cx * CELL_PX, 0); ctx.lineTo(cx * CELL_PX, H); ctx.stroke();
    }
    for (let cy = 0; cy <= r.height * 2; cy++) {
      ctx.beginPath(); ctx.moveTo(0, cy * CELL_PX); ctx.lineTo(W, cy * CELL_PX); ctx.stroke();
    }
  }

  const marks = [
    ["warps", cssVar("--warp"), "W"],
    ["signs", cssVar("--sign"), "S"],
    ["objects", cssVar("--obj"), "N"],
  ];
  ctx.font = "bold 10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [key, colour, letter] of marks) {
    for (let i = 0; i < (r[key] || []).length; i++) {
      const e = r[key][i];
      const sel = opts.selEnt && opts.selEnt.key === key && opts.selEnt.i === i;
      ctx.fillStyle = colour;
      ctx.globalAlpha = sel ? 1 : 0.78;
      ctx.fillRect(e.x * CELL_PX + 1, e.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 / scale;
        ctx.strokeRect(e.x * CELL_PX + 1, e.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
      }
      ctx.fillStyle = "#f0f0f8";
      ctx.fillText(letter, e.x * CELL_PX + CELL_PX / 2, e.y * CELL_PX + CELL_PX / 2 + 1);
    }
  }
  // A wizard's "you are placing it here" marker.
  if (opts.marker && opts.marker.x >= 0) {
    ctx.strokeStyle = "#c85048";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(opts.marker.x * CELL_PX, opts.marker.y * CELL_PX, CELL_PX, CELL_PX);
    ctx.fillStyle = "rgba(155,188,15,0.45)";
    ctx.fillRect(opts.marker.x * CELL_PX, opts.marker.y * CELL_PX, CELL_PX, CELL_PX);
  }

  // The Select tool's marquee, dashed so it reads as a selection outline
  // rather than a fourth kind of paint. While it's being dragged to a new
  // spot, a second, solid rect shows where it would land.
  if (opts.selectRect) {
    const sr = opts.selectRect;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeStyle = "#f0f0f8";
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(sr.x0 * BLOCK_PX, sr.y0 * BLOCK_PX, rectW(sr) * BLOCK_PX, rectH(sr) * BLOCK_PX);
    ctx.setLineDash([]);
  }
  if (opts.selectPreview) {
    const sp = opts.selectPreview;
    ctx.strokeStyle = cssVar("--accent");
    ctx.lineWidth = 2 / scale;
    ctx.strokeRect(sp.x0 * BLOCK_PX, sp.y0 * BLOCK_PX, rectW(sp) * BLOCK_PX, rectH(sp) * BLOCK_PX);
  }

  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

function renderMapCanvas() {
  drawMapInto($("#mapCanvas"), curMap(), mapScale, {
    walk: $("#showWalk").checked,
    grid: $("#showGrid").checked,
    selEnt: P.sel.mapEnt,
    selectRect, selectPreview,
    border: true,
  });
}

/**
 * A small, tappable picture of a vanilla map, for "where does this go?".
 * `onPick` gets cell coordinates.
 */
function miniMap(mapId, marker, onPick) {
  // One of the mod's own maps -- committed or still a draft -- is already in
  // the exact shape drawMapInto wants, so it's used as-is rather than only
  // ever falling back to the vanilla lookup below. That fallback is what let
  // this preview a mod's own PATCH of a vanilla map by coincidence (same id);
  // a brand new REGISTERed map never had that coincidence to lean on.
  const own = P.maps.find((x) => x.id === mapId) || P.mapDrafts.find((x) => x.id === mapId);
  const src = own ? own.rec : GAME?.maps?.[mapId];
  const cv = el("canvas", { style: "image-rendering:pixelated;touch-action:none;cursor:crosshair;max-width:100%" });
  if (!src) return el("div", { class: "hint" }, "No picture available for that map.");

  const m = own || { rec: { ...src } };
  // Fit the dialog without going below one device pixel per game pixel.
  const scale = Math.max(1, Math.min(2, Math.floor(320 / (src.width * BLOCK_PX)) || 1));
  // onReady: redraw -- if the tileset's Image has not decoded yet, this
  // canvas would otherwise be stuck showing the numbered-block placeholder
  // (drawMapInto's fallback for "no picture yet") until something unrelated
  // forced a re-render.
  const redraw = () => drawMapInto(cv, m, scale, { walk: true, marker, onReady: redraw });
  redraw();

  cv.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const rect = cv.getBoundingClientRect();
    const cx = Math.floor((ev.clientX - rect.left) / (rect.width / (src.width * 2)));
    const cy = Math.floor((ev.clientY - rect.top) / (rect.height / (src.height * 2)));
    if (cx < 0 || cy < 0 || cx >= src.width * 2 || cy >= src.height * 2) return;
    marker.x = cx; marker.y = cy;
    redraw();
    onPick?.(cx, cy);
  });
  return cv;
}

// Whichever tileset the palette is currently showing -- in compound mode
// that's the paint-from dropdown, otherwise the map's own fixed tileset.
// Shared with the Export button, since "what's being used" means the same
// thing there.
function paletteTilesetId(m) {
  const z = zoneOf(m);
  return z.compound ? (z.paintTs || m.rec.tileset) : m.rec.tileset;
}

function renderBlockPalette() {
  const host = $("#blockPal");
  const pick = $("#tilesetPick");
  host.textContent = "";
  pick.textContent = "";
  const m = curMap();
  if (!m) { renderZoneControls(); return; }
  const z = zoneOf(m);

  // In compound mode the dropdown chooses which tileset the PALETTE shows --
  // it never repaints anything already on the map. That is the whole
  // difference between "mix tilesets" on and off, so the label says which
  // job it is currently doing.
  if (z.compound) {
    pick.append(el("div", { class: "hint" }, "Painting with blocks from:"));
    pick.append(refSelect("tilesets", () => z.paintTs || m.rec.tileset,
      (v) => { z.paintTs = v; selBlock = 0; touch(); renderMapTab(); }, { blank: "— pick a tileset —" }));
  } else if (m.verb === "register") {
    pick.append(refSelect("tilesets", () => m.rec.tileset,
      (v) => { m.rec.tileset = v; z.paintTs = v; renderMapTab(); }, { blank: "— pick a tileset —" }));
  } else {
    pick.append(el("div", { class: "hint" }, "Tileset: " + m.rec.tileset + " (fixed by the vanilla map)"));
  }

  renderZoneControls();

  const palTs = paletteTilesetId(m);
  const ts = GAME?.tilesets?.[palTs];
  if (!ts) { host.append(el("div", { class: "empty" }, "Load game data to see real blocks.")); return; }
  sheetFor(palTs);

  ts.blocks.forEach((block, idx) => {
    const sel = idx === selBlock;
    const c = el("canvas", {
      width: BLOCK_PX, height: BLOCK_PX,
      title: "block " + idx + (z.subtile ? " — click a quarter" : ""),
      class: sel ? "sel" : "",
    });
    c.style.width = c.style.height = "28px";
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = false;
    cx.drawImage(zoneBlockCanvas(palTs, idx), 0, 0);

    if (z.subtile) {
      // A cross-hair over the whole swatch, so it reads as four pickable
      // quarters rather than one solid block -- the click handler below
      // already worked this way, the swatch just never said so.
      const half = BLOCK_PX / 2;
      cx.strokeStyle = cssVar("--ink");
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(half, 0); cx.lineTo(half, BLOCK_PX);
      cx.moveTo(0, half); cx.lineTo(BLOCK_PX, half);
      cx.stroke();

      // The specific quarter currently loaded as the brush, if it belongs
      // to this block -- marked on top of the cross-hair so "this exact
      // corner" reads as clearly as ".sel" already makes "this whole block".
      if (zoneSelQuad && zoneSelQuad.ts === palTs && zoneSelQuad.blk === idx) {
        const qx = (zoneSelQuad.q % 2) * half, qy = Math.floor(zoneSelQuad.q / 2) * half;
        cx.strokeStyle = cssVar("--accent2");
        cx.lineWidth = 2;
        cx.strokeRect(qx + 1, qy + 1, half - 2, half - 2);
      }
    }

    // Sub-tile mode picks a QUARTER of a block, so which quarter was clicked
    // has to come out of the click position rather than the block alone.
    c.addEventListener("click", (ev) => {
      if (z.subtile) {
        const r = c.getBoundingClientRect();
        const q = (ev.clientY - r.top > r.height / 2 ? 2 : 0) + (ev.clientX - r.left > r.width / 2 ? 1 : 0);
        zoneSelQuad = { ts: palTs, blk: idx, q };
      }
      selBlock = idx;
      renderBlockPalette();
    });
    host.append(c);
  });
}

/**
 * The block Map:blockAt (src/world/Map.lua) returns for every out-of-bounds
 * cell -- always resolved against the map's own declared tileset (`r.tileset`),
 * never whatever the palette above happens to be painting from, since it is
 * one flat map-level setting rather than something painted cell by cell.
 * A small picker of its own keeps that distinction visible instead of
 * quietly reusing selBlock, which could belong to a different tileset
 * entirely in compound mode.
 */
function renderBorderFill() {
  const host = $("#borderFill");
  if (!host) return;
  host.textContent = "";
  const m = curMap();
  if (!m) return;
  const r = m.rec;
  const ts = GAME?.tilesets?.[r.tileset];
  if (!ts) { host.append(el("div", { class: "empty" }, "Load game data to see real blocks.")); return; }
  sheetFor(r.tileset);

  host.append(el("div", { class: "hint" },
    "What the player sees walking off the edge of the map — tiled forever, so pick something that "
    + "repeats cleanly."));

  const grid = el("div", { class: "row", style: "flex-wrap:wrap;gap:2px" });
  ts.blocks.forEach((block, idx) => {
    const sel = idx === (r.borderBlock || 0);
    const c = el("canvas", {
      width: BLOCK_PX, height: BLOCK_PX, title: "block " + idx, class: sel ? "sel" : "",
    });
    c.style.width = c.style.height = "22px";
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = false;
    cx.drawImage(zoneBlockCanvas(r.tileset, idx), 0, 0);
    c.addEventListener("click", () => {
      r.borderBlock = idx;
      touch();
      renderMapTab();
    });
    grid.append(c);
  });
  host.append(grid);
}

/* ------------------------------------------------------------- painting -- */

function cellFromEvent(ev) {
  const cv = $("#mapCanvas");
  const rect = cv.getBoundingClientRect();
  // #mapCanvas always draws with opts.border (see renderMapCanvas), so its
  // pixel origin sits one block into the canvas -- subtract that back out or
  // every click reads one block short of where the cursor actually is.
  const x = (ev.clientX - rect.left) / mapScale - BLOCK_PX;
  const y = (ev.clientY - rect.top) / mapScale - BLOCK_PX;
  return { cx: Math.floor(x / CELL_PX), cy: Math.floor(y / CELL_PX), bx: Math.floor(x / BLOCK_PX), by: Math.floor(y / BLOCK_PX) };
}

/* --------------------------------------------------------- select tool -- */

// Block-space rectangles are x0..x1 / y0..y1 INCLUSIVE throughout.
const rectW = (rc) => rc.x1 - rc.x0 + 1;
const rectH = (rc) => rc.y1 - rc.y0 + 1;
const normRect = (bx0, by0, bx1, by1) =>
  ({ x0: Math.min(bx0, bx1), y0: Math.min(by0, by1), x1: Math.max(bx0, bx1), y1: Math.max(by0, by1) });

function clampCell(m, bx, by) {
  return { bx: Math.max(0, Math.min(bx, m.rec.width - 1)), by: Math.max(0, Math.min(by, m.rec.height - 1)) };
}

// Keeps a rect's size fixed while keeping it inside the map -- for dragging
// an existing selection, which moves but never resizes.
function clampMoveRect(m, rc) {
  const w = rectW(rc), h = rectH(rc);
  const x0 = Math.max(0, Math.min(rc.x0, m.rec.width - w));
  const y0 = Math.max(0, Math.min(rc.y0, m.rec.height - h));
  return { x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
}

/**
 * Move the blocks (and whatever tileset/quad mix they carry) inside `from`
 * to `to`, leaving `from` cleared behind them.
 *
 * Snapshot first, clear second, paste third -- in that order an overlapping
 * move (drag a selection a couple of cells over) reads its old pixels before
 * any of them get erased, rather than smearing them across the destination.
 */
function moveSelection(m, from, to) {
  if (from.x0 === to.x0 && from.y0 === to.y0) return;
  const r = m.rec, w = rectW(from), h = rectH(from);
  const snap = [];
  for (let dy = 0; dy < h; dy++) {
    const row = [];
    for (let dx = 0; dx < w; dx++) {
      const k = (from.y0 + dy) * r.width + (from.x0 + dx);
      row.push({ block: r.blocks[k], ts: r._blockTs[k], quads: r._blockQuads[k] ? r._blockQuads[k].map((q) => ({ ...q })) : null });
    }
    snap.push(row);
  }
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const k = (from.y0 + dy) * r.width + (from.x0 + dx);
      r.blocks[k] = 0; r._blockTs[k] = null; r._blockQuads[k] = null;
    }
  }
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const tx = to.x0 + dx, ty = to.y0 + dy;
      if (tx < 0 || ty < 0 || tx >= r.width || ty >= r.height) continue;
      const k = ty * r.width + tx;
      const src = snap[dy][dx];
      r.blocks[k] = src.block; r._blockTs[k] = src.ts; r._blockQuads[k] = src.quads;
    }
  }
  m.dirtyBlocks = true;
  touch();
}

function entityAt(m, cx, cy) {
  for (const key of ["objects", "warps", "signs"]) {
    const i = (m.rec[key] || []).findIndex((e) => e.x === cx && e.y === cy);
    if (i >= 0) return { key, i };
  }
  return null;
}

function applyTool(ev) {
  const m = curMap();
  if (!m) return;
  const p = cellFromEvent(ev);
  const r = m.rec;
  if (p.bx < 0 || p.by < 0 || p.bx >= r.width || p.by >= r.height) return;

  const z = zoneOf(m);
  const k = p.by * r.width + p.bx;

  switch (mapTool) {
    case "paint": {
      if (z.subtile) {
        // Painting a quarter turns the cell into a mixed block. An ordinary
        // block being quartered for the first time is expanded into four
        // refs to itself, so the other three quarters keep their old look.
        if (!zoneSelQuad) { toast("Click a quarter of a block in the palette first", true); break; }
        const qi = (p.cy & 1) * 2 + (p.cx & 1);
        const existing = quadsOf(m, p.bx, p.by);
        const own = blockTsOf(m, p.bx, p.by);
        const quads = existing
          ? existing.map((q) => ({ ...q }))
          : [0, 1, 2, 3].map((n) => ({ ts: own, blk: r.blocks[k] || 0, q: n }));
        quads[qi] = { ...zoneSelQuad };
        r._blockQuads[k] = quads;
        m.dirtyBlocks = true;
        touch();
        break;
      }
      const wantTs = z.compound ? (z.paintTs || r.tileset) : r.tileset;
      const changed = r.blocks[k] !== selBlock || (r._blockTs[k] || r.tileset) !== wantTs || r._blockQuads[k];
      if (changed) {
        r.blocks[k] = selBlock;
        r._blockTs[k] = z.compound ? wantTs : null;
        // A whole block replaces whatever quadrant mixing was there.
        r._blockQuads[k] = null;
        m.dirtyBlocks = true;
        touch();
      }
      break;
    }
    // Pick up whatever is already on a cell as the new brush -- the exact
    // quad under the cursor if that cell is quartered there, otherwise the
    // whole block and the tileset it actually came from (which might not be
    // the map's own, in compound mode) -- then hands off to Paint right
    // away, the way an eyedropper behaves everywhere else it exists.
    case "eyedrop": {
      const qi = (p.cy & 1) * 2 + (p.cx & 1);
      const quads = quadsOf(m, p.bx, p.by);
      const picked = quads ? quads[qi] : { ts: blockTsOf(m, p.bx, p.by), blk: r.blocks[k] || 0, q: qi };
      selBlock = picked.blk;
      z.paintTs = picked.ts;
      zoneSelQuad = { ...picked };
      renderBlockPalette();
      selectMapTool("paint");
      break;
    }
    // Collision is per CELL, not per block -- see src/zone.js for why these
    // three write/clear an override rather than editing the tile under the
    // cursor.
    case "solid":
    case "walk": {
      const want = mapTool === "walk";
      const natural = (() => {
        const forced = cellSolidOf(m, p.cx, p.cy);
        setCellSolid(m, p.cx, p.cy, null);
        const n = zoneIsWalkable(m, p.cx, p.cy);
        setCellSolid(m, p.cx, p.cy, forced);
        return n;
      })();
      // Asking for what the tile already does clears the override instead of
      // recording a redundant one -- that keeps the atlas from growing a
      // duplicate tile for a cell that never needed one.
      setCellSolid(m, p.cx, p.cy, natural === want ? null : want);
      if (z.compound === false) {
        z.compound = true;
        toast("Mixing tilesets turned on — painted collision needs the map's own tileset");
      }
      m.dirtyBlocks = true;
      touch(); renderZoneControls();
      break;
    }
    case "reset":
      setCellSolid(m, p.cx, p.cy, null);
      m.dirtyBlocks = true;
      touch(); renderZoneControls();
      break;
    // A door's warps-table entry does nothing on its own -- the engine also
    // needs the cell's own tile flagged doorTiles/warpTiles (see zone.js).
    // This paints that flag directly, for a cell whose tile has no natural
    // source to inherit it from -- see buildZoneTileset for the case where
    // it isn't needed at all.
    case "warptile":
      setCellWarpTile(m, p.cx, p.cy, !cellWarpTileOf(m, p.cx, p.cy));
      if (z.compound === false) {
        z.compound = true;
        toast("Mixing tilesets turned on — a warp trigger needs the map's own tileset");
      }
      m.dirtyBlocks = true;
      touch(); renderZoneControls();
      break;
    case "warp":
      r.warps.push({ x: p.cx, y: p.cy, destMap: "PALLET_TOWN", destWarp: 1 });
      P.sel.mapEnt = { key: "warps", i: r.warps.length - 1 };
      touch(); renderMapInspector();
      break;
    case "sign":
      r.signs.push({ x: p.cx, y: p.cy, text: "TEXT_NEW_SIGN" });
      P.sel.mapEnt = { key: "signs", i: r.signs.length - 1 };
      touch(); renderMapInspector();
      break;
    case "npc": {
      // Vanilla object indices are single digits; start well clear of them so
      // save keys like "<mapId>_obj_<index>" never collide.
      const used = new Set(r.objects.map((o) => o.index));
      let index = 90;
      while (used.has(index)) index++;
      r.objects.push({
        index, x: p.cx, y: p.cy, sprite: "SPRITE_BEAUTY",
        movement: "STAY", range: "NONE", text: "", name: "NEW_NPC_" + index,
      });
      P.sel.mapEnt = { key: "objects", i: r.objects.length - 1 };
      touch(); renderMapInspector();
      break;
    }
    case "pick":
      P.sel.mapEnt = entityAt(m, p.cx, p.cy);
      renderMapInspector();
      break;
    case "remove": {
      const hit = entityAt(m, p.cx, p.cy);
      if (hit) {
        r[hit.key].splice(hit.i, 1);
        // Any other selected index in the same array may have just shifted.
        P.sel.mapEnt = null;
        touch(); renderMapInspector();
      }
      break;
    }
  }
  renderMapCanvas();
}

// The tools that make sense as a stroke rather than a click. Collision is one
// of them: a wall is a run of cells, and clicking each of twenty separately is
// not how anybody wants to draw one.
const DRAG_TOOLS = new Set(["paint", "solid", "walk", "reset", "warptile"]);
// Which of those key their drag-dedup by whole BLOCK rather than by the
// finer 16px cell -- painting acts on the block under the cursor, same as
// the palette it's driven from.
const BLOCK_DRAG_TOOLS = new Set(["paint"]);

/**
 * The Select tool: drag on empty space to marquee a new rectangle of blocks,
 * drag from inside the current rectangle to move it. Handled entirely
 * outside applyTool()'s per-cell dispatch, since it needs to track a rect
 * across a whole drag rather than react to one cell at a time.
 */
function wireSelectTool(cv) {
  let marqueeStart = null; // {bx, by} anchor while dragging a brand-new box
  let moveFrom = null;     // {rect, grabDx, grabDy} while dragging the existing one

  cv.addEventListener("pointerdown", (ev) => {
    if (mapTool !== "select") return;
    ev.preventDefault();
    const m = curMap();
    if (!m) return;
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic event, no capture */ }
    const { bx, by } = cellFromEvent(ev);
    const c = clampCell(m, bx, by);
    if (selectRect && c.bx >= selectRect.x0 && c.bx <= selectRect.x1 && c.by >= selectRect.y0 && c.by <= selectRect.y1) {
      moveFrom = { rect: { ...selectRect }, grabDx: c.bx - selectRect.x0, grabDy: c.by - selectRect.y0 };
    } else {
      marqueeStart = c;
      selectRect = normRect(c.bx, c.by, c.bx, c.by);
    }
    renderMapCanvas();
  });
  cv.addEventListener("pointermove", (ev) => {
    if (mapTool !== "select" || (!marqueeStart && !moveFrom)) return;
    const m = curMap();
    if (!m) return;
    const { bx, by } = cellFromEvent(ev);
    const c = clampCell(m, bx, by);
    if (marqueeStart) {
      selectRect = normRect(marqueeStart.bx, marqueeStart.by, c.bx, c.by);
    } else {
      const w = rectW(moveFrom.rect), h = rectH(moveFrom.rect);
      selectPreview = clampMoveRect(m, {
        x0: c.bx - moveFrom.grabDx, y0: c.by - moveFrom.grabDy,
        x1: c.bx - moveFrom.grabDx + w - 1, y1: c.by - moveFrom.grabDy + h - 1,
      });
    }
    renderMapCanvas();
  });
  const finish = () => {
    if (moveFrom && selectPreview) {
      moveSelection(curMap(), moveFrom.rect, selectPreview);
      selectRect = selectPreview;
    }
    marqueeStart = null; moveFrom = null; selectPreview = null;
    renderMapCanvas();
  };
  cv.addEventListener("pointerup", finish);
  cv.addEventListener("pointercancel", finish);
}

/**
 * The Objects group's own Select tool: click a warp/sign/NPC to select it
 * (same as before), drag to move it. Cell-exact rather than block-relative
 * like the Textures Select tool above -- an object drags only itself, and
 * there's no underlying content to snapshot/clear/paste at the destination.
 */
function wireObjectDragTool(cv) {
  let dragging = null; // {key, i} into curMap().rec, while a grabbed entity follows the pointer

  cv.addEventListener("pointerdown", (ev) => {
    if (mapTool !== "pick") return;
    const m = curMap();
    if (!m) return;
    const p = cellFromEvent(ev);
    const hit = entityAt(m, p.cx, p.cy);
    P.sel.mapEnt = hit;
    renderMapInspector();
    if (hit) {
      ev.preventDefault();
      try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic event, no capture */ }
      dragging = hit;
    }
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const m = curMap();
    if (!m) return;
    const e = (m.rec[dragging.key] || [])[dragging.i];
    if (!e) { dragging = null; return; }
    const p = cellFromEvent(ev);
    const cx = Math.max(0, Math.min(p.cx, m.rec.width * 2 - 1));
    const cy = Math.max(0, Math.min(p.cy, m.rec.height * 2 - 1));
    if (e.x === cx && e.y === cy) return;
    e.x = cx; e.y = cy;
    renderMapCanvas(); renderMapInspector();
  });
  const finish = () => {
    if (dragging) touch();
    dragging = null;
  };
  cv.addEventListener("pointerup", finish);
  cv.addEventListener("pointercancel", finish);
}

// An optional readout in the right margin -- independent of whatever tool is
// active, since knowing exactly which block/cell the cursor is over is
// useful while painting, placing objects, or just reading the map.
function wireCoordDisplay(cv) {
  const out = $("#mapCoords");
  cv.addEventListener("pointermove", (ev) => {
    if (!out || !$("#showCoords")?.checked) return;
    const m = curMap();
    if (!m) { out.textContent = ""; return; }
    const p = cellFromEvent(ev);
    out.textContent = `Block ${p.bx}, ${p.by}  ·  Cell ${p.cx}, ${p.cy}`;
  });
  cv.addEventListener("pointerleave", () => { if (out) out.textContent = ""; });
}

// Mouse wheel (and a trackpad's pinch, which the browser already reports as
// wheel deltas) zooms in place; two touch points doing the same gesture on a
// phone do it by hand, tracked independently since there's no wheel event to
// piggyback on there. Both just move the same knob the 1x/2x/3x buttons do --
// mapScale doesn't care which one asked.
function wireZoom(cv) {
  const MIN = 0.5, MAX = 4;
  const setScale = (s) => {
    if (!curMap()) return;
    mapScale = Math.max(MIN, Math.min(MAX, s));
    renderMapCanvas();
    renderMapInspector();
  };

  cv.addEventListener("wheel", (ev) => {
    if (!curMap()) return;
    ev.preventDefault();
    setScale(mapScale + (ev.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });

  const touches = new Map(); // pointerId -> {x, y}, touch-type pointers only
  let pinchStartDist = null, pinchStartScale = 1;
  cv.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartScale = mapScale;
    }
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2 && pinchStartDist) {
      const [a, b] = [...touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      setScale(pinchStartScale * (dist / pinchStartDist));
    }
  });
  const release = (ev) => {
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinchStartDist = null;
  };
  cv.addEventListener("pointerup", release);
  cv.addEventListener("pointercancel", release);
}

function wireMapCanvas() {
  const cv = $("#mapCanvas");
  wireSelectTool(cv);
  wireObjectDragTool(cv);
  wireCoordDisplay(cv);
  wireZoom(cv);
  let painting = false;
  let lastKey = null;
  cv.addEventListener("pointerdown", (ev) => {
    if (mapTool === "select" || mapTool === "pick") return;
    ev.preventDefault();
    painting = DRAG_TOOLS.has(mapTool);
    lastKey = null;
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic event, no capture */ }
    applyTool(ev);
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!painting || mapTool === "select" || mapTool === "pick") return;
    // Collision toggles are idempotent per cell but NOT per pixel: dragging
    // across one cell would otherwise re-run the "is this redundant?" test
    // dozens of times and flicker the override on and off under the cursor.
    const p = cellFromEvent(ev);
    const key = BLOCK_DRAG_TOOLS.has(mapTool) ? p.bx + "," + p.by : p.cx + "," + p.cy;
    if (key === lastKey) return;
    lastKey = key;
    applyTool(ev);
  });
  cv.addEventListener("pointerup", () => { painting = false; });
  cv.addEventListener("pointercancel", () => { painting = false; });
}

/* ------------------------------------------------------------ inspector -- */

function renderMapList() {
  const host = $("#mapList");
  host.textContent = "";
  if (!P.maps.length && !P.mapDrafts.length) { host.append(el("div", { class: "empty" }, "No maps yet.")); return; }
  for (const m of P.mapDrafts) {
    host.append(el("div", {
      class: "item" + (m.uid === P.sel.map ? " sel" : ""),
      onclick: () => { P.sel.map = m.uid; P.sel.mapEnt = null; renderMapTab(); },
    },
      el("span", { class: "tag " + m.verb }, m.verb),
      el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" },
        (m.rec.label || m.id) + "  (not added yet)"),
      el("button", {
        class: "x", title: "discard",
        onclick: (ev) => { ev.stopPropagation(); discardMapDraft(m); },
      }, "✕")));
  }
  for (const m of P.maps) {
    host.append(el("div", {
      class: "item" + (m.uid === P.sel.map ? " sel" : ""),
      onclick: () => { P.sel.map = m.uid; P.sel.mapEnt = null; renderMapTab(); },
    },
      el("span", { class: "tag " + m.verb }, m.verb),
      el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" }, m.rec.label || m.id),
      el("button", {
        class: "x", title: "delete",
        onclick: (ev) => { ev.stopPropagation(); deleteMap(m); },
      }, "✕")));
  }
}

// Top and centered, like the other four workspaces' own Add-to-mod bar --
// the Maps screen has no worksteps column to put it at the head of, so it
// sits above the canvas instead, sticky the same way (see .workbar's own
// `position: sticky`). Handles the committed case too (a plain "Delete"),
// since a map -- unlike the others -- had no equivalent anywhere before:
// a patch auto-created by placing an NPC/encounter/item ball is real,
// shipping content the moment that placement is added, and used to have no
// on-screen sign of that at all.
function renderMapBar() {
  const host = $("#mapBar");
  if (!host) return;
  host.textContent = "";
  const m = curMap();
  if (!m) return;

  if (isMapDraft(m)) {
    const why = mapDraftBlocker(m);
    host.append(el("div", { class: "workbar" },
      el("div", { style: "flex:1" }),
      el("button", {
        id: "mapAddDraft", class: "primary fixed", disabled: !!why, title: why || "",
        onclick: () => addMapDraft(m),
      }, "Add to the mod"),
      el("div", { style: "flex:1" }),
      el("button", { class: "fixed danger", onclick: () => discardMapDraft(m) }, "Discard")));
    host.append(el("p", { id: "mapDraftWhy", class: "hint" + (why ? " warn" : ""), style: "margin:4px 12px" }, mapDraftWhyText(why)));
  } else {
    // Same spot "Add to the mod" sat in before it was added -- a quiet pulse
    // once editing pauses (flashUpdated, driven by touch()'s own debounce),
    // not a button, since edits (painting, moving objects, editing warps)
    // already apply live and autosave as they're made.
    host.append(el("div", { class: "workbar" },
      el("div", { style: "flex:1" }),
      el("span", { id: "mapUpdated", class: "updated-flash" }, "Updated"),
      el("div", { style: "flex:1" }),
      el("button", { class: "fixed danger", onclick: () => deleteMap(m) }, "Delete")));
  }
}

function renderMapInspector() {
  const host = $("#mapInspector");
  host.textContent = "";
  const m = curMap();
  if (!m) { host.append(el("div", { class: "empty" }, "Create or select a map.")); return; }
  const r = m.rec;

  host.append(el("h2", {}, m.verb === "patch" ? "Patching " + m.base : "New map"));
  if (m.verb === "patch") {
    host.append(el("p", { class: "hint" },
      "Only what you add gets written, using __append, so vanilla entries survive."
      + (m.dirtyBlocks ? " Terrain was edited, so the whole blocks array ships." : "")));
  }

  // Label drives the id the same way a Pokemon's or NPC's name does -- typed
  // once, in plain words, with the SHOUTY_ID the engine actually wants
  // derived from it and shown as a reference underneath rather than as a
  // second box to keep in sync by hand. A patch is the one exception: its id
  // IS the vanilla map it patches, so that can't follow a relabel -- the id
  // line still shows it, just never as something typed into.
  const idLine = el("p", { class: "hint" },
    m.verb === "patch" ? `Patches the engine's own ${m.id}.` : `The engine will know it as ${r.id || "—"}.`);
  host.append(labelledInput("Label", r.label, (v) => {
    r.label = v;
    if (m.verb !== "patch") {
      r.id = m.id = idFromName(v);
      idLine.textContent = `The engine will know it as ${r.id || "—"}.`;
      syncMapDraftReady(m);
    }
    renderMapList();
  }));
  host.append(idLine);

  if (m.verb === "register") {
    host.append(el("p", { class: "hint" }, "The tileset picker sits above the blocks, on the left."));

    const size = el("div", { class: "grid2" });
    for (const dim of ["width", "height"]) {
      size.append(el("div", {},
        el("label", {}, dim + " (blocks)"),
        el("input", {
          type: "number", min: 1, max: 60, value: r[dim],
          onchange: (e) => { resizeMap(m, dim, Math.max(1, +e.target.value || 1)); },
        })));
    }
    host.append(size);
    host.append(el("label", {}, "Map index"));
    host.append(el("input", {
      type: "number", value: r.index,
      onchange: (e) => { r.index = +e.target.value; touch(); renderLint?.(); },
    }));
    host.append(el("p", { class: "hint" }, "Vanilla tops out at 247 — keep new maps at 1000+."));
  }

  host.append(el("h2", {}, "Zoom"));
  host.append(el("div", { class: "row" },
    ...[1, 2, 3].map((z) => el("button", {
      class: z === mapScale ? "primary" : "",
      onclick: () => { mapScale = z; renderMapCanvas(); renderMapInspector(); },
    }, z + "×"))));

  const sel = P.sel.mapEnt;
  if (!sel || !r[sel.key]?.[sel.i]) {
    host.append(el("h2", {}, "Contents"));
    for (const [key, word] of [["objects", "NPCs"], ["warps", "warps"], ["signs", "signs"]]) {
      host.append(el("div", { class: "hint" }, `${(r[key] || []).length} ${word}`));
    }
    host.append(el("p", { class: "hint" }, "Use Select and tap one to edit it."));
    return;
  }

  const e = r[sel.key][sel.i];
  host.append(el("h2", {}, sel.key.slice(0, -1) + " #" + (sel.i + 1)));

  const num = (k, label) => el("div", {},
    el("label", {}, label),
    el("input", { type: "number", min: 0, value: e[k], oninput: (ev) => { e[k] = +ev.target.value; touch(); renderMapCanvas(); } }));
  host.append(el("div", { class: "grid2" }, num("x", "cell x"), num("y", "cell y")));

  if (sel.key === "warps") {
    // A patched map's real, exported warp count is vanilla's own PLUS
    // whatever this mod appended -- reading GAME's own count alone would
    // undercount the moment the destination has any of its own, which is
    // exactly the easy-to-miss-by-one that breaks a return warp: "PALLET_TOWN
    // has 3 warps" reads as license to use destWarp 1-3 even once a 4th,
    // appended one exists there too.
    const warpsOf = (mapId) => {
      const own = P.maps.find((x) => x.id === mapId) || (P.mapDrafts || []).find((x) => x.id === mapId);
      return { own, warps: own ? (own.rec.warps || []) : (GAME?.maps?.[mapId]?.warps || null) };
    };
    // Two ways to guess right: if the destination already has a warp that
    // leads back to the map we're on, that IS the door this one is meant to
    // pair with -- use its index. Otherwise assume the pair doesn't exist
    // yet and this one will be appended next, landing at count+1 (the same
    // arithmetic the "connect two maps" wizard flow already relies on).
    const suggestDestWarp = (mapId, fromMapId) => {
      const { own, warps } = warpsOf(mapId);
      if (!warps) return null;
      let backIdx = -1;
      for (let i = warps.length - 1; i >= 0; i--) if (warps[i].destMap === fromMapId) { backIdx = i; break; }
      return { own, count: warps.length, suggested: backIdx >= 0 ? backIdx + 1 : warps.length + 1, matched: backIdx >= 0 };
    };

    const destField = el("div", {});
    destField.append(el("label", {}, "Destination map"));
    destField.append(refSelect("maps", () => e.destMap, (v) => { e.destMap = v.toUpperCase(); }, {
      // Picking a destination is the moment enough is known to suggest the
      // right destWarp. The old value was an index into whatever map
      // destMap *used* to be, so overwriting it here is a correction, not
      // a guess.
      onChange: () => {
        const info = suggestDestWarp(e.destMap, r.id);
        if (info) e.destWarp = info.suggested;
        renderMapInspector();
      },
    }));
    host.append(destField);

    host.append(el("label", {}, "Destination warp (1-based)"));
    host.append(el("input", { type: "number", min: 1, value: e.destWarp, oninput: (ev) => { e.destWarp = +ev.target.value; touch(); } }));
    const info = suggestDestWarp(e.destMap, r.id);
    if (info) {
      host.append(el("p", { class: "hint" },
        `${e.destMap} has ${info.count} warp${info.count === 1 ? "" : "s"}`
        + (info.own ? " once your own additions are counted" : "") + ". "
        + (info.matched
          ? `Its own warp back to here is #${info.suggested} — that's what destWarp should be.`
          : `A door back usually wants ${info.suggested} — the one you're about to add there — not a number already taken.`)));
    }
  }

  if (sel.key === "signs") {
    host.append(labelledInput("TEXT constant", e.text, (v) => { e.text = v.toUpperCase(); }));
  }

  if (sel.key === "objects") {
    // Someone the NPC workspace made keeps a display name and a TEXT constant
    // in step with this one, so renaming here has to go the same way it would
    // there rather than leaving the two screens disagreeing about who this is.
    host.append(labelledInput("Name", e._display ?? e.name,
      e._display !== undefined ? (v) => renameNpc(e, v) : (v) => { e.name = v; }));
    host.append(el("label", {}, "Index"));
    host.append(el("input", { type: "number", value: e.index, oninput: (ev) => { e.index = +ev.target.value; touch(); } }));
    host.append(labelledInput("Sprite", e.sprite, (v) => { e.sprite = v.toUpperCase(); }, "sprites"));

    const pick = (k, options) => {
      host.append(el("label", {}, k));
      host.append(el("select", { onchange: (ev) => { e[k] = ev.target.value; touch(); } },
        ...options.map((o) => el("option", { value: o, selected: e[k] === o }, o))));
    };
    pick("movement", ["STAY", "WALK"]);
    pick("range", ["NONE", "ANY_DIR", "UP_DOWN", "LEFT_RIGHT", "DOWN", "UP", "LEFT", "RIGHT"]);

    // The cross-tab seam: an NPC's TEXT constant is what a talk script binds
    // to, so it is picked from the scripts that exist rather than retyped.
    host.append(el("h2", {}, "What it says"));
    const talks = P.scripts.filter((s) => s.kind === "talk");
    const sel2 = el("select", {
      onchange: (ev) => { e.text = ev.target.value; touch(); renderMapInspector(); },
    },
      el("option", { value: "" }, "— nothing —"),
      ...talks.map((s) => el("option", { value: s.textKey, selected: e.text === s.textKey }, s.name + "  (" + s.textKey + ")")),
      e.text && !talks.some((s) => s.textKey === e.text) ? el("option", { value: e.text, selected: true }, e.text) : null);
    host.append(sel2);
    host.append(el("button", {
      style: "margin-top:6px",
      onclick: () => {
        const s = newScript(e.name || "npc talk", m.id, "talk");
        P.scripts.push(s);
        e.text = s.textKey;
        P.sel.script = s.uid;
        touch();
        toast("Script created — see the Scripts tab");
        renderMapInspector();
        renderScriptTab();
      },
    }, "+ Write a script for this NPC"));
  }

  host.append(el("h2", {}, ""));
  host.append(el("button", {
    class: "danger",
    onclick: () => { r[sel.key].splice(sel.i, 1); P.sel.mapEnt = null; touch(); renderMapCanvas(); renderMapInspector(); },
  }, "Delete this"));
}

function resizeMap(m, dim, value) {
  const r = m.rec;
  const w = dim === "width" ? value : r.width;
  const h = dim === "height" ? value : r.height;
  const oldW = r.width, oldH = r.height;
  const next = new Array(w * h).fill(0);
  for (let y = 0; y < Math.min(h, r.height); y++)
    for (let x = 0; x < Math.min(w, r.width); x++)
      next[y * w + x] = r.blocks[y * r.width + x];
  r.blocks = next;
  r.width = w;
  r.height = h;
  // The per-cell tileset, quadrant and collision arrays are indexed off the
  // same width, so they have to be re-laid the same way or a map that grows
  // sideways shears them one row further along each line.
  if (typeof resizeZoneArrays === "function") resizeZoneArrays(m, oldW, oldH, w, h);

  // Warps/signs/objects sit on their own 16px cell grid (width*2 by
  // height*2), independent of the blocks array above -- shrinking has to
  // drop anything that just fell outside the new edge, or the map hangs on
  // to a warp at a cell that no longer exists. A no-op on growth: nothing
  // that was already in bounds can fall outside a larger one.
  const cw = w * 2, ch = h * 2;
  const inBounds = (e) => e.x >= 0 && e.y >= 0 && e.x < cw && e.y < ch;
  let removed = 0;
  for (const key of ["warps", "signs", "objects"]) {
    const before = (r[key] || []).length;
    r[key] = (r[key] || []).filter(inBounds);
    removed += before - r[key].length;
  }
  if (removed) {
    P.sel.mapEnt = null;
    toast(`${removed} thing${removed > 1 ? "s" : ""} outside the new size removed.`);
  }

  m.dirtyBlocks = true;
  touch();
  renderMapTab();
}

function renderMapTab() {
  renderMapList();
  renderMapBar();
  renderBlockPalette();
  renderBorderFill();
  renderMapCanvas();
  renderMapInspector();
}
