"use strict";
/* ============================================================================
   Oak's Lab — the zone engine: compound tilesets, sub-tile quadrants and
   painted collision.

   Ported from the standalone Gen1 Zone Editor (gen1recomp-zone-editor) and
   adapted to Oak's Lab's own map model, so the Maps tab gains the zone
   editor's authoring power without any of the rest of the tool having to
   change: an Oak's Lab map is still `{verb, id, rec:{blocks, warps, signs,
   objects, ...}}`, which is what NPC placement, item balls, the wizard and
   the linter all already read and write.

   Four capabilities, and one hard engine fact behind all of them.

   THE FACT (src/world/Map.lua:221, verified in the shipped source):

       return self.walkable[self:cellTile(cx, cy)] or false

   Walkability is a property of the TILE INDEX, looked up in the tileset's
   `walkable` list. It is NOT per-cell, and there is no per-map collision
   layer anywhere in the registry. That single line decides the shape of all
   three features below.

   1. COMPOUND TILESETS (on by default). A vanilla map may only use blocks
      from one tileset. Compound mode lets every block cell remember which
      tileset it came from (`rec._blockTs`), and on export every distinct
      tile actually used is composited into one brand-new atlas PNG with the
      blocks re-indexed against it. The map then names that new tileset. This
      is on by default because it costs nothing when unused -- a map that
      never strays from one tileset merges back to exactly that tileset and
      ships no PNG at all (see buildZoneTileset's single-source fast path).

   2. SUB-TILES (off by default). Splits each 32x32 block into four 16x16
      quadrants that can be painted independently, so one map block can mix
      quarters from different blocks or tilesets (`rec._blockQuads`). Off by
      default because it multiplies the block count in the compounded atlas
      and is a sharper tool than most maps need.

   3. PAINTED COLLISION. Because of THE FACT, "make this one cell solid"
      cannot be stored on the cell. What it can do -- and what this does -- is
      mint a SECOND COPY of that tile in the compounded atlas: identical
      pixels, a different index, and only one of the two listed in `walkable`.
      The cell then points at whichever copy it needs. That is why collision
      painting requires the compounded atlas (and so quietly turns compound
      mode on), and why it is honest to call it painting rather than a lie
      over a read-only overlay.

   4. WARP TRIGGERS. src/world/Map.lua's Warp.onArrive only fires when a cell
      is BOTH in the map's warps table AND its bottom-left tile is listed in
      the tileset's doorTiles/warpTiles -- the warps table alone (what the
      Objects > Warp tool drops) is not enough. Marking a cell here adds its
      resolved tile to the compounded atlas's `warpTiles`. Unlike collision
      this never needs a duplicate tile: warpTiles is its own list, so the
      same atlas slot can be walkable, a warp trigger, both, or neither.

   All four ride on underscore-prefixed keys of `rec`, which `forEngine`
   already strips, so nothing here leaks into main.lua except through the
   deliberate export path below.
   ========================================================================== */

/* --------------------------------------------------------------- state -- */

// Per-map authoring answers the engine has no field for. Created lazily so a
// map made before this existed (or loaded from an older autosave) still works.
function zoneOf(m) {
  const r = m.rec;
  if (!r._zone) {
    r._zone = {
      // Compound is the default: it is free when unused and removes the
      // "wrong tileset" dead end that otherwise ends a first map.
      compound: true,
      subtile: false,
      // paintTs is which tileset the palette is currently showing. It is NOT
      // the map's tileset -- in compound mode the map's own `tileset` field
      // is only a fallback for cells that never recorded one.
      paintTs: r.tileset,
    };
  }
  if (!r._blockTs) r._blockTs = new Array(r.width * r.height).fill(null);
  if (!r._blockQuads) r._blockQuads = new Array(r.width * r.height).fill(null);
  // Per-CELL collision overrides: null = "whatever the tile says", true =
  // forced walkable, false = forced solid. Cell grid, so width*2 by height*2.
  if (!r._cellSolid) r._cellSolid = new Array(r.width * 2 * r.height * 2).fill(null);
  // Per-CELL warp-trigger flags: true = this cell's bottom-left 8x8 tile
  // should be listed in the exported tileset's warpTiles, so the engine's
  // Map:isWarpTileCell actually fires here (src/world/Map.lua). A warp
  // placed on the Objects grid is otherwise inert -- the engine only checks
  // this per-tile flag, never the warps table by itself.
  if (!r._cellWarpTile) r._cellWarpTile = new Array(r.width * 2 * r.height * 2).fill(null);
  return r._zone;
}

const zoneIdx = (m, bx, by) => by * m.rec.width + bx;
const zoneCellIdx = (m, cx, cy) => cy * m.rec.width * 2 + cx;

/**
 * The readers below are deliberately tolerant of a map that has never been
 * through zoneOf().
 *
 * `miniMap` (map.js) draws throwaway `{rec: {...vanillaMap}}` objects that
 * never touch the authoring path -- the NPC workspace's "tap where they
 * stand" and the Items workspace's item-ball placement both go through it.
 * Those must keep drawing as plain vanilla maps rather than being given
 * zone arrays they will never use, so every accessor answers "nothing
 * recorded" instead of assuming the arrays are there.
 */
function blockTsOf(m, bx, by) {
  const z = m.rec._zone;
  if (z && !z.compound) return m.rec.tileset;
  return m.rec._blockTs?.[zoneIdx(m, bx, by)] || m.rec.tileset;
}

const quadsOf = (m, bx, by) => m.rec._blockQuads?.[zoneIdx(m, bx, by)] || null;
const cellSolidOf = (m, cx, cy) => m.rec._cellSolid?.[zoneCellIdx(m, cx, cy)] ?? null;

function setCellSolid(m, cx, cy, v) {
  zoneOf(m);
  m.rec._cellSolid[zoneCellIdx(m, cx, cy)] = v;
}

// Has anything on this map been given a collision override?
const hasPaintedCollision = (m) =>
  (m.rec._cellSolid || []).some((v) => v !== null && v !== undefined);

const cellWarpTileOf = (m, cx, cy) => m.rec._cellWarpTile?.[zoneCellIdx(m, cx, cy)] ?? null;

function setCellWarpTile(m, cx, cy, v) {
  zoneOf(m);
  m.rec._cellWarpTile[zoneCellIdx(m, cx, cy)] = v;
}

// Has any cell on this map been marked as a warp trigger?
const hasWarpTriggers = (m) => (m.rec._cellWarpTile || []).some(Boolean);

// Every tileset this map draws from, including through mixed quadrants. The
// canvas needs all of them decoded before it can paint a borrowed block.
function zoneTilesetsUsed(m) {
  const r = m.rec;
  const out = new Set([r.tileset]);
  for (const t of r._blockTs || []) if (t) out.add(t);
  for (const q of r._blockQuads || []) if (q) for (const ref of q) out.add(ref.ts);
  return out;
}

// Does this map use more than one tileset, or any mixed block?
function isMixed(m) {
  const r = m.rec;
  if ((r._blockQuads || []).some(Boolean)) return true;
  const seen = new Set();
  for (let i = 0; i < r.width * r.height; i++) seen.add(r._blockTs?.[i] || r.tileset);
  return seen.size > 1;
}

/* ------------------------------------------------------------ resizing -- */

// The three parallel arrays have to follow the blocks array through a resize,
// or a map that grows sideways silently shears its own tileset/quad/collision
// data one row further along each line.
function resizeZoneArrays(m, oldW, oldH, w, h) {
  const r = m.rec;
  zoneOf(m);
  const remap = (src, ow, oh, nw, nh, fill) => {
    const out = new Array(nw * nh).fill(fill);
    for (let y = 0; y < Math.min(oh, nh); y++)
      for (let x = 0; x < Math.min(ow, nw); x++) out[y * nw + x] = src[y * ow + x];
    return out;
  };
  r._blockTs = remap(r._blockTs, oldW, oldH, w, h, null);
  r._blockQuads = remap(r._blockQuads, oldW, oldH, w, h, null);
  r._cellSolid = remap(r._cellSolid, oldW * 2, oldH * 2, w * 2, h * 2, null);
  r._cellWarpTile = remap(r._cellWarpTile, oldW * 2, oldH * 2, w * 2, h * 2, null);
}

/* ------------------------------------------------------------- drawing -- */

// One 32x32 block, composited to a canvas and cached. Keyed by tileset+index
// so switching tilesets in the palette does not thrash the cache.
const zoneBlockCache = new Map();
function zoneBlockCanvas(tsId, idx) {
  const key = tsId + ":" + idx;
  const hit = zoneBlockCache.get(key);
  if (hit) return hit;
  const ts = GAME?.tilesets?.[tsId];
  const sheet = sheetFor(tsId);
  const c = document.createElement("canvas");
  c.width = BLOCK_PX; c.height = BLOCK_PX;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  const b = ts?.blocks?.[idx];
  if (b && sheet?.complete && sheet.naturalWidth) {
    for (let i = 0; i < 16; i++) {
      const t = b[i];
      g.drawImage(sheet, (t % ts.tilesPerRow) * TILE, Math.floor(t / ts.tilesPerRow) * TILE, TILE, TILE,
        (i % 4) * TILE, Math.floor(i / 4) * TILE, TILE, TILE);
    }
    // Only cache once the art is really there; a block drawn from a
    // half-decoded sheet would otherwise be cached blank forever.
    zoneBlockCache.set(key, c);
  } else {
    g.fillStyle = "#552222";
    g.fillRect(0, 0, BLOCK_PX, BLOCK_PX);
  }
  return c;
}

// A quadrant ref is { ts, blk, q } -- which quarter of which block of which
// tileset. Four of them make one mixed block.
const quadKey = (quads) => quads.map((r) => r.ts + ":" + r.blk + ":" + r.q).join("|");

const zoneQuadCache = new Map();
function zoneCompositeCanvas(quads) {
  const key = quadKey(quads);
  const hit = zoneQuadCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = BLOCK_PX; c.height = BLOCK_PX;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  let complete = true;
  quads.forEach((ref, qi) => {
    const ts = GAME?.tilesets?.[ref.ts];
    const sheet = sheetFor(ref.ts);
    const def = ts?.blocks?.[ref.blk];
    if (!def || !(sheet?.complete && sheet.naturalWidth)) { complete = false; return; }
    // Read the quadrant the user picked (ref.q), draw it at the quadrant it
    // occupies on the map (qi) -- these are independent.
    const sox = (ref.q % 2) * 2, soy = ref.q >= 2 ? 2 : 0;
    const dox = (qi % 2) * 2, doy = qi >= 2 ? 2 : 0;
    for (let ly = 0; ly < 2; ly++) {
      for (let lx = 0; lx < 2; lx++) {
        const t = def[(soy + ly) * 4 + (sox + lx)];
        g.drawImage(sheet, (t % ts.tilesPerRow) * TILE, Math.floor(t / ts.tilesPerRow) * TILE, TILE, TILE,
          (dox + lx) * TILE, (doy + ly) * TILE, TILE, TILE);
      }
    }
  });
  if (complete) zoneQuadCache.set(key, c);
  return c;
}

// What to draw for one block cell: a mixed composite if it has one, else the
// plain block from whichever tileset that cell uses.
function zoneCellCanvas(m, bx, by) {
  const quads = quadsOf(m, bx, by);
  if (quads) return zoneCompositeCanvas(quads);
  return zoneBlockCanvas(blockTsOf(m, bx, by), m.rec.blocks[zoneIdx(m, bx, by)] || 0);
}

/* ---------------------------------------------------------- collision -- */

// The tile index a cell's collision is decided by, following the engine's own
// bottom-left rule through whichever of the three block shapes this cell is.
function zoneCellTileRef(m, cx, cy) {
  const bx = cx >> 1, by = cy >> 1;
  const quads = quadsOf(m, bx, by);
  // bottom-left 8x8 tile of the 16x16 cell
  const tx = (cx & 1) * 2, ty = (cy & 1) * 2 + 1;
  if (quads) {
    const qi = (cy & 1) * 2 + (cx & 1);
    const ref = quads[qi];
    const ts = GAME?.tilesets?.[ref.ts];
    const def = ts?.blocks?.[ref.blk];
    if (!def) return null;
    const sox = (ref.q % 2) * 2, soy = ref.q >= 2 ? 2 : 0;
    // within the quadrant, the bottom-left of the two-by-two
    return { ts: ref.ts, tile: def[(soy + 1) * 4 + sox] };
  }
  const tsId = blockTsOf(m, bx, by);
  const ts = GAME?.tilesets?.[tsId];
  const def = ts?.blocks?.[m.rec.blocks[zoneIdx(m, bx, by)] || 0];
  if (!def) return null;
  return { ts: tsId, tile: def[ty * 4 + tx] };
}

/**
 * Is this cell walkable, as the player will find it?
 *
 * A painted override wins outright -- that is the whole point of the feature,
 * and the export below makes it true by minting a tile copy on the right side
 * of the walkable list. With no override this is the engine's own answer.
 */
function zoneIsWalkable(m, cx, cy) {
  const forced = cellSolidOf(m, cx, cy);
  if (forced === true) return true;
  if (forced === false) return false;
  const ref = zoneCellTileRef(m, cx, cy);
  if (!ref) return true;
  const ts = GAME?.tilesets?.[ref.ts];
  if (!ts?.walkable) return true;
  return ts.walkable.includes(ref.tile);
}

/**
 * Would this cell actually fire a warp, per src/world/Map.lua's
 * isWarpTileCell -- a manual mark wins outright, otherwise it's whatever the
 * resolved tile's own source tileset already says (doorTiles or warpTiles).
 * Used by the lint pass to catch a warp entry sitting on plain scenery, which
 * is silently inert in-game rather than an error anywhere in the data.
 */
function zoneIsWarpTile(m, cx, cy) {
  if (cellWarpTileOf(m, cx, cy)) return true;
  const ref = zoneCellTileRef(m, cx, cy);
  if (!ref) return false;
  const ts = GAME?.tilesets?.[ref.ts];
  if (!ts) return false;
  return !!(ts.doorTiles?.includes(ref.tile) || ts.warpTiles?.includes(ref.tile));
}

/* --------------------------------------------------------------- export -- */

const zoneTilesetId = (m) => (m.rec.id || "ZONE") + "_TILES";
const zoneTilesetFile = (m) => "art/" + zoneTilesetId(m).toLowerCase() + ".png";

/**
 * Build the tileset a zone actually needs, re-indexed against itself.
 *
 * Returns null when the map is plain -- one tileset, no mixed blocks, no
 * painted collision -- because then the vanilla tileset already says
 * everything and minting a copy of it would be pure noise in the export.
 *
 * The collision trick lives in `tileKey`: a tile is identified by
 * (tileset, index, forcedWalkability), so the same pixels asked for both ways
 * land in two different atlas slots and only one goes in `walkable`.
 */
function buildZoneTileset(m) {
  const r = m.rec;
  zoneOf(m);
  const painted = hasPaintedCollision(m);
  const triggered = hasWarpTriggers(m);
  if (!isMixed(m) && !painted && !triggered) return null;

  const tiles = [];                 // {tsId, tile, solid} in atlas order
  const tileIndexByKey = new Map(); // key -> atlas index
  const blocks = [];                // atlas block definitions (16 tile ids)
  const blockIndexByKey = new Map();
  const remapped = new Array(r.width * r.height).fill(0);
  // Warp triggers don't need a duplicate atlas slot the way collision does --
  // warpTiles is its own independent list, not a second value for a boolean
  // that walkable already owns -- so this just collects which atlas indices
  // a marked cell landed on.
  const warpTileIndices = new Set();

  const tileKey = (tsId, tile, solid) => tsId + "::" + tile + "::" + String(solid);
  const takeTile = (tsId, tile, solid) => {
    const key = tileKey(tsId, tile, solid);
    let idx = tileIndexByKey.get(key);
    if (idx === undefined) {
      idx = tiles.length;
      tiles.push({ tsId, tile, solid });
      tileIndexByKey.set(key, idx);
    }
    return idx;
  };

  // The 16 source tiles of one map block, as {ts, tile} in reading order.
  const sourceTilesFor = (bx, by) => {
    const quads = quadsOf(m, bx, by);
    const out = new Array(16);
    if (quads) {
      quads.forEach((ref, qi) => {
        const ts = GAME?.tilesets?.[ref.ts];
        const def = ts?.blocks?.[ref.blk] || new Array(16).fill(0);
        const sox = (ref.q % 2) * 2, soy = ref.q >= 2 ? 2 : 0;
        const dox = (qi % 2) * 2, doy = qi >= 2 ? 2 : 0;
        for (let ly = 0; ly < 2; ly++)
          for (let lx = 0; lx < 2; lx++)
            out[(doy + ly) * 4 + dox + lx] = { ts: ref.ts, tile: def[(soy + ly) * 4 + sox + lx] };
      });
      return out;
    }
    const tsId = blockTsOf(m, bx, by);
    const ts = GAME?.tilesets?.[tsId];
    const def = ts?.blocks?.[r.blocks[zoneIdx(m, bx, by)] || 0] || new Array(16).fill(0);
    for (let i = 0; i < 16; i++) out[i] = { ts: tsId, tile: def[i] };
    return out;
  };

  for (let by = 0; by < r.height; by++) {
    for (let bx = 0; bx < r.width; bx++) {
      const src = sourceTilesFor(bx, by);

      // Collision is decided per CELL, and a block holds four of them. Only
      // the bottom-left tile of each cell carries walkability, so only those
      // four positions can be forced -- the other twelve are pure decoration
      // and are always taken in their natural state.
      const forced = new Array(16).fill(null);
      // Same bottom-left-of-cell positions as collision, since it's the same
      // engine rule (Map:cellTile) deciding which sub-tile a warp check reads.
      const triggerPos = [];
      for (let q = 0; q < 4; q++) {
        const cx = bx * 2 + (q % 2), cy = by * 2 + (q >= 2 ? 1 : 0);
        const tx = (q % 2) * 2, ty = (q >= 2 ? 2 : 0) + 1;
        const f = cellSolidOf(m, cx, cy);
        if (f !== null && f !== undefined) forced[ty * 4 + tx] = f;
        if (cellWarpTileOf(m, cx, cy)) triggerPos.push(ty * 4 + tx);
      }

      const ids = src.map((t, i) => takeTile(t.ts, t.tile, forced[i]));
      for (const pos of triggerPos) warpTileIndices.add(ids[pos]);
      const key = ids.join(",");
      let bi = blockIndexByKey.get(key);
      if (bi === undefined) {
        bi = blocks.length;
        blocks.push(ids);
        blockIndexByKey.set(key, bi);
      }
      remapped[zoneIdx(m, bx, by)] = bi;
    }
  }

  // The border block (Map:blockAt's out-of-bounds fallback, src/world/
  // Map.lua) is always resolved against the map's own declared tileset --
  // it is a flat map-level setting, never a per-cell override -- so it needs
  // the same atlas remap every real block just got, or a compounded map
  // would ship a border index into a tileset it no longer has.
  const borderTs = GAME?.tilesets?.[r.tileset];
  const borderDef = borderTs?.blocks?.[r.borderBlock || 0] || new Array(16).fill(0);
  const borderIds = borderDef.map((t) => takeTile(r.tileset, t, null));
  const borderKey = borderIds.join(",");
  let borderBlock = blockIndexByKey.get(borderKey);
  if (borderBlock === undefined) {
    borderBlock = blocks.length;
    blocks.push(borderIds);
    blockIndexByKey.set(borderKey, borderBlock);
  }

  // Which atlas tiles are walkable: a forced tile says so itself, an ordinary
  // one inherits its source tileset's answer.
  const walkable = [];
  tiles.forEach((t, idx) => {
    const ts = GAME?.tilesets?.[t.tsId];
    const natural = !!ts?.walkable?.includes(t.tile);
    const walk = t.solid === null || t.solid === undefined ? natural : t.solid;
    if (walk) walkable.push(idx);
  });

  // A tile copied in from a tileset where it was already a real door/warp
  // tile keeps that -- same inheritance as walkable above -- so painting
  // with, say, a real cave-hole graphic just works without also having to
  // mark it here. The manual mark only carries weight for a cell whose tile
  // has no such source to inherit from (a hand-uploaded, all-decoration atlas).
  tiles.forEach((t, idx) => {
    const ts = GAME?.tilesets?.[t.tsId];
    if (ts?.doorTiles?.includes(t.tile) || ts?.warpTiles?.includes(t.tile)) warpTileIndices.add(idx);
  });

  const tilesPerRow = 16;
  const imageWidth = tilesPerRow * TILE;
  const imageHeight = Math.max(TILE, Math.ceil(tiles.length / tilesPerRow) * TILE);

  return {
    id: zoneTilesetId(m), file: zoneTilesetFile(m),
    tiles, blocks, walkable, remapped, borderBlock,
    warpTiles: [...warpTileIndices],
    tilesPerRow, imageWidth, imageHeight,
  };
}

// Paint the atlas described by buildZoneTileset into a canvas. Separate from
// the build so the export can be computed (and counted) without a canvas, and
// so the same description can be drawn at preview size.
function zoneTilesetCanvas(built) {
  const c = document.createElement("canvas");
  c.width = built.imageWidth; c.height = built.imageHeight;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  built.tiles.forEach((t, idx) => {
    const ts = GAME?.tilesets?.[t.tsId];
    const sheet = sheetFor(t.tsId);
    if (!ts || !(sheet?.complete && sheet.naturalWidth)) return;
    g.drawImage(sheet,
      (t.tile % ts.tilesPerRow) * TILE, Math.floor(t.tile / ts.tilesPerRow) * TILE, TILE, TILE,
      (idx % built.tilesPerRow) * TILE, Math.floor(idx / built.tilesPerRow) * TILE, TILE, TILE);
  });
  return c;
}

/**
 * Every zone tileset this mod ships, as records for buildLua, plus the PNG
 * bytes for files(). Only maps that actually need one appear.
 *
 * A map whose art the user has re-imported (`rec._tilesetPng`) ships THAT
 * instead of a freshly composited atlas -- the whole point of the export /
 * edit / import round trip is that the edited pixels are what reaches the
 * game, while the block and walkable tables stay the ones Oak's Lab worked
 * out.
 */
function zoneTilesetRecords() {
  const out = [];
  for (const m of P.maps) {
    const built = buildZoneTileset(m);
    if (!built) continue;
    const data = {
      id: built.id,
      // A bare string here is a mod-relative path the engine has no reason
      // to know about: src/render/Assets.lua only rewrites "assets/generated/
      // ..." paths, so anything else reaches love.graphics.newImage exactly
      // as written and misses -- this is what "Could not open file art/...
      // .png. Does not exist." actually is. mod.assets:path() (src/mods/
      // Loader.lua) resolves it against this mod's own real folder instead.
      image: "@lua:mod.assets:path(" + luaStr(built.file) + ")",
      imageWidth: built.imageWidth, imageHeight: built.imageHeight,
      tilesPerRow: built.tilesPerRow,
      blocks: built.blocks, walkable: built.walkable,
    };
    // Every world-map colour scheme except ADVANCED works by tinting the
    // WHOLE map through one named palette (OverworldController.paletteNameFor
    // reads map.def.palette, falling back through a byTileset/byMap table
    // this editor has no access to, then to whatever outdoor map the player
    // last stood on) -- it is not per-tile, so a compounded tileset does not
    // break it on its own. A patch never touches `palette`, so a patched
    // vanilla map (m.base set) keeps shading correctly for free; forcing
    // trueColor here would throw that inheritance away for no reason (the
    // exact "colors are wrong" case OverworldController.lua's own comment
    // warns about -- true-color art re-run through an unrelated palette).
    // A brand-new map has no vanilla palette to inherit at all, so it still
    // needs the escape hatch -- see TileRenderer.lua:497.
    if (m.verb !== "patch") data.trueColor = true;
    if (built.warpTiles.length) data.warpTiles = built.warpTiles;
    if (built.warpTiles.length) data.warpTiles = built.warpTiles;
    out.push({ id: built.id, data });
  }
  return out;
}

function zoneTilesetFiles() {
  const out = [];
  for (const m of P.maps) {
    const built = buildZoneTileset(m);
    if (!built) continue;
    const edited = m.rec._tilesetPng;
    const b64 = edited || zoneTilesetCanvas(built).toDataURL("image/png").split(",")[1];
    out.push({ name: built.file, bytes: base64Bytes(b64) });
  }
  return out;
}

// The tileset name and blocks array a map exports with: its own compounded
// atlas when it needs one, otherwise exactly what it always had.
function zoneExportFor(m) {
  const built = buildZoneTileset(m);
  if (!built) return { tileset: m.rec.tileset, blocks: m.rec.blocks, borderBlock: m.rec.borderBlock };
  return { tileset: built.id, blocks: built.remapped, borderBlock: built.borderBlock };
}

/* ------------------------------------------------------------------- UI -- */

// The two mode toggles and the sub-tile brush preview, drawn under the
// tileset picker on the Maps tab.
function renderZoneControls() {
  const m = curMap();
  const hint = $("#zoneModeHint");
  const quadHost = $("#zoneQuadPick");
  const compound = $("#zoneCompound");
  const subtile = $("#zoneSubtile");
  if (!hint || !quadHost || !compound || !subtile) return;
  quadHost.textContent = "";
  hint.textContent = "";
  if (!m) { compound.disabled = subtile.disabled = true; renderZoneArt(); return; }

  const z = zoneOf(m);
  compound.disabled = subtile.disabled = false;
  compound.checked = !!z.compound;
  subtile.checked = !!z.subtile;

  const bits = [];
  if (z.compound) {
    bits.push("Blocks from any tileset can go on this map; the ones you use are merged into one "
      + "tileset of its own when you export.");
  } else {
    bits.push("One tileset for the whole map, the way a vanilla map is built.");
  }
  if (z.subtile) {
    bits.push("Click a QUARTER of a block in the palette to pick it, then paint — each 16px cell "
      + "of a block can come from somewhere different.");
  }
  if (hasPaintedCollision(m)) {
    const n = (m.rec._cellSolid || []).filter((v) => v !== null && v !== undefined).length;
    bits.push(`${n} cell${n === 1 ? "" : "s"} have had their collision painted.`);
  }
  if (hasWarpTriggers(m)) {
    const n = (m.rec._cellWarpTile || []).filter(Boolean).length;
    bits.push(`${n} cell${n === 1 ? "" : "s"} marked as a warp trigger.`);
  }
  hint.textContent = bits.join(" ");

  if (z.subtile && zoneSelQuad) {
    const wrap = el("div", { class: "row", style: "align-items:center;gap:6px;margin:4px 0" });
    const c = el("canvas", { width: 16, height: 16 });
    c.style.width = c.style.height = "32px";
    c.style.imageRendering = "pixelated";
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = false;
    // Draw just the chosen quarter, magnified -- the brush, not the block.
    g.drawImage(zoneBlockCanvas(zoneSelQuad.ts, zoneSelQuad.blk),
      (zoneSelQuad.q % 2) * 16, (zoneSelQuad.q >= 2 ? 16 : 0), 16, 16, 0, 0, 16, 16);
    wrap.append(el("span", { class: "hint" }, "Brush:"), c,
      el("span", { class: "hint" }, `${zoneSelQuad.ts} block ${zoneSelQuad.blk}`));
    quadHost.append(wrap);
  } else if (z.subtile) {
    quadHost.append(el("div", { class: "hint" }, "Click a quarter of a block below to start."));
  }

  renderZoneArt();
}

/**
 * Export / import the art a zone actually uses.
 *
 * The export is the compounded atlas exactly as it would ship, so what comes
 * back from a paint program lines up tile-for-tile with the block and
 * walkable tables Oak's Lab worked out -- the import replaces the PIXELS
 * only, and deliberately never re-reads the grid. That is what makes the
 * round trip safe: re-deriving blocks from an edited image would throw away
 * the collision work, since two tiles that now look different might still be
 * the walkable/solid pair the painter minted.
 */
function renderZoneArt() {
  const host = $("#zoneArt");
  if (!host) return;
  host.textContent = "";
  const m = curMap();
  if (!m) { host.append(el("div", { class: "hint" }, "Select a map.")); return; }

  const built = buildZoneTileset(m);
  if (!built) {
    host.append(el("div", { class: "hint" },
      "This map uses one of the game's own tilesets unchanged, so it ships no art of its own. "
      + "Paint with a second tileset, mix sub-tiles, or block off a cell and it gets a tileset "
      + "here that you can export and repaint."));
    return;
  }

  host.append(el("div", { class: "hint" },
    `${built.tiles.length} tiles, ${built.blocks.length} blocks — exports as `,
    el("code", {}, built.file), "."));

  if (m.rec._tilesetPng) {
    host.append(el("p", { class: "hint good" },
      "Using your edited copy of this art. The block and collision tables are still Oak's Lab's, "
      + "so the tiles have to stay in the same places."));
  }

  const preview = el("canvas");
  const src = m.rec._tilesetPng ? null : zoneTilesetCanvas(built);
  preview.width = built.imageWidth; preview.height = built.imageHeight;
  preview.style.width = Math.min(240, built.imageWidth * 2) + "px";
  preview.style.imageRendering = "pixelated";
  preview.style.background = "#fff";
  const pg = preview.getContext("2d");
  pg.imageSmoothingEnabled = false;
  if (src) pg.drawImage(src, 0, 0);
  else {
    const img = new Image();
    img.onload = () => pg.drawImage(img, 0, 0);
    img.src = "data:image/png;base64," + m.rec._tilesetPng;
  }
  host.append(preview);

  const row = el("div", { class: "row", style: "margin-top:6px" });
  row.append(el("button", {
    class: "fixed",
    onclick: () => {
      const cv = m.rec._tilesetPng ? null : zoneTilesetCanvas(built);
      if (cv) {
        cv.toBlob((b) => download(b, built.id.toLowerCase() + ".png"), "image/png");
      } else {
        download(new Blob([base64Bytes(m.rec._tilesetPng)], { type: "image/png" }),
          built.id.toLowerCase() + ".png");
      }
    },
  }, "Export the art"));

  const input = el("input", { type: "file", accept: "image/png,image/*", style: "display:none" });
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
    if (img.width !== built.imageWidth || img.height !== built.imageHeight) {
      toast(`That image is ${img.width}x${img.height}; this tileset is `
        + `${built.imageWidth}x${built.imageHeight}. Export it first and paint over that.`, true);
      return;
    }
    m.rec._tilesetPng = b64;
    touch(); renderMapTab();
    toast("Art replaced — the map now draws with your version");
  };
  row.append(el("button", { class: "fixed", onclick: () => input.click() }, "Import edited art"));
  row.append(input);
  if (m.rec._tilesetPng) {
    row.append(el("button", {
      class: "fixed danger",
      onclick: () => { delete m.rec._tilesetPng; touch(); renderMapTab(); },
    }, "Revert"));
  }
  host.append(row);

  host.append(el("p", { class: "hint", style: "margin-top:6px" },
    "Export gives you the exact sheet this map ships. Paint over it, keeping every tile in its "
    + "own 8x8 square, and import it back — the map keeps its blocks and its collision, and just "
    + "wears your art instead."));
}
