#!/usr/bin/env node
// Build data/gamedata.json -- the vanilla tables Oak's Lab draws maps with and,
// more importantly, the id lists behind every dropdown in the tool. Nobody has
// 151 species ids memorised, so no field should ever ask them to type one.
//
// This data is decoded from the player's own ROM on first boot, so it is
// ROM-derived and must never ship inside a published mod or a published copy
// of this tool. It is a local artefact: every user regenerates it from their
// own install. See "No ROM content in mods" in the wiki.
//
//   node tools/extract-gamedata.mjs [zone_editor.html] [generated-data-dir]
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLuaData } from "./lua-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const editorPath = resolve(process.argv[2] || join(ROOT, "..", "zone_editor.html"));
const dataDir = resolve(process.argv[3] ||
  join(process.env.APPDATA || join(process.env.HOME || "", ".local/share"), "pokemon-love2d/red/data/generated"));
// data/generated sits two levels under the game root; the decoded art sits
// beside it under assets/generated, and sprites.lua names its files relative
// to that root.
const gameRoot = resolve(dataDir, "..", "..");

/* ---------------------------------------------- tiles, blocks and layout -- */

const html = await readFile(editorPath, "utf8");
const blob = html.match(/<script id="DATA" type="application\/json">([\s\S]*?)<\/script>/);
if (!blob) {
  console.error(`No DATA blob in ${editorPath}.`);
  console.error("Pass the path to a zone_editor.html generated from your install.");
  process.exit(1);
}
const raw = JSON.parse(blob[1]);

const maps = {};
for (const [id, full] of Object.entries(raw.mapsFull || {})) {
  const summary = (raw.maps || {})[id] || {};
  maps[id] = {
    id, label: summary.label || id, index: summary.index,
    tileset: full.t, width: full.w, height: full.h,
    blocks: full.b, borderBlock: full.bb,
    connections: full.c || {},
    warps: full.wp || [], signs: full.sg || [], objects: full.ob || [],
  };
  // The zone editor drops each object's `index`, but it is the object's
  // identity everywhere else -- the save keys defeated/taken state by
  // "<mapId>_obj_<index>", and trainer_headers.lua is keyed by it. Checked
  // against maps.lua: all 916 vanilla objects have index === position.
  maps[id].objects.forEach((o, i) => { if (o && o.index === undefined) o.index = i + 1; });
}

const tilesets = {};
for (const [id, ts] of Object.entries(raw.tilesets || {})) {
  tilesets[id] = {
    id, blocks: ts.blocks, tilesPerRow: ts.tilesPerRow,
    walkable: ts.walkable, doorTiles: ts.doorTiles || [],
    warpTiles: ts.warpTiles || [], counterTiles: ts.counterTiles || [],
    png: ts.png,
  };
}

/* ------------------------------------------------------------- id lists -- */

async function loadTable(name) {
  try { return parseLuaData(await readFile(join(dataDir, name + ".lua"), "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.warn(`  ${name}.lua: ${e.message}`);
    return null;
  }
}

// One entry per option in a dropdown: the id the engine wants, plus the human
// name to show beside it.
const toOptions = (table, { name = "name", extra } = {}) =>
  !table ? [] : Object.entries(table)
    .filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
    .map(([id, v]) => {
      const o = { id, name: typeof v[name] === "string" ? v[name] : id };
      if (extra) Object.assign(o, extra(v));
      return o;
    })
    .sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.id.localeCompare(b.id));

// Some registries have no file of their own -- their id space is whatever the
// records reference. Harvest it rather than hardcoding a list that will rot.
const harvest = (table, pick) => {
  const seen = new Set();
  for (const v of Object.values(table || {})) for (const x of [pick(v)].flat()) if (typeof x === "string") seen.add(x);
  return [...seen].sort().map((id) => ({ id, name: id }));
};

const [pokemon, items, moves, trainers, typeChart, encounters, audio, palettes, sprites, tilesetTable,
       textTable, textPointers, trainerHeaders, icons, battleAnims] =
  await Promise.all(["pokemon", "items", "moves", "trainers", "type_chart", "encounters", "audio", "palettes", "sprites", "tilesets",
                     "text", "text_pointers", "trainer_headers", "icons", "battle_anims"].map(loadTable));

const ids = {
  pokemon:   toOptions(pokemon, { extra: (v) => ({ index: v.dex }) }),
  items:     toOptions(items,   { extra: (v) => ({ index: v.index }) }),
  moves:     toOptions(moves,   { extra: (v) => ({ index: v.index }) }),
  trainers:  toOptions(trainers,{ extra: (v) => ({ index: v.index }) }),
  maps:      Object.values(maps).map((m) => ({ id: m.id, name: m.label, index: m.index })),
  tilesets:  Object.keys(tilesets).sort().map((id) => ({ id, name: id })),
  sprites:   (raw.sprites || []).map((s) => ({ id: s.id, name: s.id, walker: s.walker })),
};

if (typeChart?.matchups) {
  const types = new Set();
  for (const m of typeChart.matchups) { types.add(m.attacker); types.add(m.defender); }
  ids.type_chart = [...types].filter(Boolean).sort().map((id) => ({ id, name: id }));
}
ids.growth_rates  = harvest(pokemon, (v) => v.growthRate);
ids.move_effects  = harvest(moves,   (v) => v.effect);
ids.item_effects  = harvest(items,   (v) => v.effect);
ids.evolution_methods = harvest(pokemon, (v) => (v.evolutions || []).map((e) => e.method));
// palettes.lua is not a registry of records like the others -- it is three
// tables (order / palettes / pokemon), so toOptions read its two OBJECT keys
// as the id list and every "palette" dropdown offered "palettes" and
// "pokemon". The ids are the palette NAMES, in the ROM's own order.
ids.palettes      = (palettes?.order || Object.keys(palettes?.palettes || {}))
  .filter((id) => palettes?.palettes?.[id])
  .map((id) => ({ id, name: id }));
// OG YELLOW is the one display mode that does not read the SuperPalettes above:
// Yellow is CGB-enhanced, so PaletteFX.usesYellowCgb sends every palette name
// through pokeyellow's CGBBasePalettes instead (PaletteFX.pal ->
// yellowCgbNamedPal). That table only exists in a Yellow install, so it is
// fetched from the Yellow folder beside whichever version was extracted -- and
// if there isn't one, the mode just says so rather than showing Red's colours
// under a Yellow label.
const yellowCgb = await (async () => {
  if (palettes?.cgbBase) return palettes.cgbBase;      // the extract IS Yellow
  try {
    const y = parseLuaData(await readFile(
      join(gameRoot, "..", "yellow/data/generated/palettes.lua"), "utf8"));
    return y?.cgbBase || null;
  } catch { return null; }
})();

ids.cries         = Object.keys(audio?.cries || {}).sort().map((id) => ({ id, name: id }));

/**
 * The sound programs and cry definitions, so cries can be PLAYED not just named.
 *
 * `programs.bin` is the engine's own decode of the three ROM sound banks --
 * 48 KB, and the single source every cry's bytecode is read out of. Carrying
 * it here is what lets the browser synthesize a cry that does not exist yet:
 * a new species borrows an existing base cry and shifts its pitch and length,
 * so there is nothing to record, only something to run.
 *
 * ROM-derived like everything else in this file, and excluded from a shared
 * build by the same --no-gamedata switch.
 */
const audioBlob = await (async () => {
  const cries = audio?.cries;
  if (!cries || !audio.programFile || !audio.bankOrder) return null;
  let programs;
  try { programs = await readFile(join(gameRoot, audio.programFile)); }
  catch { return null; }
  // Only engine 1 (Red/Blue) is synthesizable by src/cry.js; a Gen 2 extract
  // uses a different bytecode and is left out rather than played wrong.
  const out = {};
  for (const [id, c] of Object.entries(cries)) {
    const h = c.header;
    if (!h || h.engine !== 1) continue;
    out[id] = { address: h.address, bank: h.bank, pitch: c.pitch || 0, length: c.length || 0 };
  }
  if (!Object.keys(out).length) return null;
  // A move's sound is an SFX header, which is the same three-byte-per-channel
  // descriptor a cry uses -- so the same synth plays both. The engine number
  // only picks which noise-instrument table a MUSIC note reads, and a battle
  // sound effect writes its noise parameter straight into the note, so every
  // bank we carry is playable regardless of which engine owns it.
  const sfx = {};
  for (const [name, h] of Object.entries(audio.sfx || {})) {
    if (!h || typeof h !== "object" || !h.address) continue;
    if (!audio.bankOrder.includes(h.bank)) continue;
    sfx[name] = { address: h.address, bank: h.bank, engine: h.engine || 1 };
  }
  return { bankOrder: audio.bankOrder, programs: programs.toString("base64"), cries: out, sfx };
})();
ids.sfx           = Object.keys(audioBlob?.sfx || audio?.sfx || {}).sort().map((id) => ({ id, name: id }));
ids.music         = [...new Set(Object.values(audio?.mapSongs || {}).filter((s) => typeof s === "string"))]
  .sort().map((id) => ({ id, name: id }));
ids.encounters    = Object.keys(encounters || {}).sort().map((id) => ({ id, name: id }));
ids.battle_anims  = Object.keys(battleAnims?.moveAnims || {}).sort().map((id) => ({ id, name: id }));

for (const [k, v] of Object.entries(ids)) if (!v.length) delete ids[k];

/* ------------------------------------------------------------------ art -- */

// A picture beats an id. "SPRITE_BALDING_GUY" tells you nothing; the 16x16
// man does. The decoded sheets are tiny -- all 73 of them come to well under
// 100 KB -- so they travel inside gamedata.json rather than as loose files a
// file:// page could never read.
async function loadPng(relPath) {
  try {
    const buf = await readFile(join(gameRoot, relPath));
    // IHDR is always the first chunk, so width and height sit at a fixed offset.
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
    return { png: buf.toString("base64"), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

// The overworld sheet is a vertical strip of 16x16 frames in a fixed order.
// Six-frame sheets walk; three-frame ones only ever stand.
const FRAME_NAMES = ["down", "up", "left", "down (step)", "up (step)", "left (step)"];

const spriteSheets = {};
for (const [id, rec] of Object.entries(sprites || {})) {
  if (!rec || typeof rec !== "object" || !rec.image) continue;
  const img = await loadPng(rec.image);
  if (!img) continue;
  spriteSheets[id] = { ...img, frames: rec.frames || Math.max(1, Math.round(img.h / 16)), walker: !!rec.walker };
}

// What the player sees when a person turns to face them in battle. Only
// trainer-class people have one, so this is keyed by file stem and matched to
// a sprite by name rather than pretended to be exhaustive.
async function loadDir(dir, prefix = "") {
  const out = {};
  let names = [];
  try { names = await readdir(join(gameRoot, dir)); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".png")) continue;
    const img = await loadPng(join(dir, f));
    if (img) out[prefix + f.slice(0, -4)] = img;
  }
  return out;
}

const facingPics = await loadDir("assets/generated/battle/trainers");
const backPics = {};
for (const stem of ["redb", "oldmanb"]) {
  const img = await loadPng(`assets/generated/battle/${stem}.png`);
  if (img) backPics[stem] = img;
}

// The 151's battle art, keyed by SPECIES id rather than by file stem -- the
// stems are abbreviated ("nidorinof", "mrmime") and nothing else in the tool
// speaks that dialect, so each record's own spriteFront/spriteBack path is
// what resolves it. This is the biggest single thing in gamedata.json and it
// earns the space: the Pokemon workspace shows you the vanilla art beside
// yours, and its Export button hands you the real PNG to paint over, which is
// how most people will actually make their first one.
const monFront = {}, monBack = {};
for (const [id, rec] of Object.entries(pokemon || {})) {
  if (!rec || typeof rec !== "object") continue;
  if (rec.spriteFront) { const img = await loadPng(rec.spriteFront); if (img) monFront[id] = img; }
  if (rec.spriteBack) { const img = await loadPng(rec.spriteBack); if (img) monBack[id] = img; }
}

/**
 * The battle animations, and the two tile sheets every one of them is drawn
 * out of.
 *
 * A Gen 1 move animation is four tables deep and none of them mean anything
 * alone: a move owns a `seq` of rows, a row names a `subanim`, a subanim is a
 * list of (frame block, base coord) pairs, and a frame block is the 8x8 tiles
 * that make one puff of smoke or one water droplet. Only the last of those is
 * a picture. Carrying all four plus the sheets is what lets src/move.js PLAY
 * an animation in the browser instead of showing an id and hoping -- and it
 * is the same data a mod writes back, so what you build in the tool is the
 * thing the engine runs.
 *
 * ~90 KB, dwarfed by the battle art already here, and the two sheets are
 * under a kilobyte each.
 */
const anims = await (async () => {
  if (!battleAnims?.moveAnims) return null;
  const sheets = {};
  for (const [index, sheet] of Object.entries(battleAnims.tilesheets || {})) {
    if (!sheet?.path) continue;
    const img = await loadPng(sheet.path);
    if (!img) continue;
    sheets[index] = { png: img.png, w: sheet.width, h: sheet.height, tiles: sheet.tiles };
  }
  // `source` is the ROM address each row was decoded from -- a provenance
  // note for the extractor, meaningless to the tool and 9 KB of it.
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "source" ? undefined : v)));
  return {
    moveAnims: strip(battleAnims.moveAnims),
    subanims: strip(battleAnims.subanims || {}),
    frameBlocks: strip(battleAnims.frameBlocks || {}),
    baseCoords: strip(battleAnims.baseCoords || {}),
    tilesheets: sheets,
  };
})();

// The party-menu icons -- the eleven animated shapes Gen 1 has, which is the
// closest thing a Pokemon has to an overworld sprite.
const iconArt = {};
for (const [name, path] of Object.entries(icons?.icons || {})) {
  if (typeof path !== "string") continue;
  const img = await loadPng(path);
  if (img) iconArt[name] = img;
}

/* ------------------------------------------------------------- dialogue -- */

// What a vanilla person actually says. A map object carries a TEXT_ constant;
// text_pointers.lua turns that into a label in text.lua, and only then is
// there a string. Resolving the chain here means the tool can show a real
// conversation instead of a constant nobody can read.
//
// text_pointers is keyed by the map's label ("PalletTown"), not its id, so it
// is re-keyed by id to match everything else in this file.
const npcText = {};
if (textPointers && textTable) {
  const byLabel = {};
  for (const m of Object.values(maps)) (byLabel[m.label] ||= []).push(m.id);
  for (const [label, entries] of Object.entries(textPointers)) {
    if (!entries || typeof entries !== "object") continue;
    for (const mapId of byLabel[label] || []) {
      for (const [constant, ptr] of Object.entries(entries)) {
        if (!ptr || typeof ptr !== "object") continue;
        const body = typeof ptr.text === "string" ? textTable[ptr.text] : null;
        if (typeof body !== "string" && !ptr.asm) continue;
        npcText[mapId] ||= {};
        // `asm` means the original was hand-written assembly with logic in it,
        // not a plain string. The words are still worth showing; the flag says
        // the real thing did more than talk.
        npcText[mapId][constant] = { text: typeof body === "string" ? body : "", asm: !!ptr.asm };
      }
    }
  }
}

/* ----------------------------------------------------------------- marts -- */

// Every shopkeeper the game already has: which map they are on, which TEXT_
// constant is theirs, and what they stock. The Items workspace needs all
// three -- the constant and the group label are what a `text_pointers:patch`
// has to name, and the stock is what makes a clerk recognisable as "the one
// who sells stones" rather than an id nobody can place.
//
// Keyed by map id like npcText above, but each entry also carries `group` --
// text_pointers' own key ("CeladonMart2F") -- because that, not the map id,
// is what the patch call addresses.
const marts = {};
if (textPointers) {
  const byLabel = {};
  for (const m of Object.values(maps)) (byLabel[m.label] ||= []).push(m.id);
  for (const [label, entries] of Object.entries(textPointers)) {
    if (!entries || typeof entries !== "object") continue;
    for (const [constant, ptr] of Object.entries(entries)) {
      if (!ptr || typeof ptr !== "object" || !Array.isArray(ptr.mart)) continue;
      for (const mapId of byLabel[label] || []) {
        marts[mapId] ||= [];
        marts[mapId].push({ constant, group: label, stock: ptr.mart });
      }
    }
  }
}

/* ------------------------------------------------------ trainer dialogue -- */

// A trainer's words are NOT in text_pointers -- their entry there is
// `asm = true` with no string, which is why importing one used to produce a
// person who says "...". The real text is in trainer_headers.lua, split three
// ways, and keyed by the object's index within the map:
//
//   battle -> what they say when they start the fight
//   won    -> what they say at the moment they lose
//   after  -> what they say when you talk to them again afterwards
//
// `event` is the flag the game sets on defeat, and `range` is the sight
// distance in tiles (0 = has to be talked to). Both are read-only facts here:
// there is no trainer_headers registry, so a mod cannot write either one.
const trainerText = {};
if (trainerHeaders && textTable) {
  const byLabel = {};
  for (const m of Object.values(maps)) (byLabel[m.label] ||= []).push(m.id);
  const str = (k) => (typeof k === "string" && typeof textTable[k] === "string" ? textTable[k] : "");

  for (const [label, entries] of Object.entries(trainerHeaders)) {
    if (!entries || typeof entries !== "object") continue;
    // The file uses both keying styles: MtMoon1F is a plain positional list,
    // CeladonGym uses explicit [2]..[8] because its object 1 is the gym leader
    // and has no header. Either way the Lua key is the object's index -- but a
    // positional Lua table (1-based) comes back from the parser as a 0-based JS
    // array, so those need the +1 putting back or every trainer gets the line
    // belonging to the one before them.
    const positional = Array.isArray(entries);
    for (const [key, h] of Object.entries(entries)) {
      const idx = positional ? Number(key) + 1 : Number(key);
      if (!h || typeof h !== "object" || !Number.isFinite(idx)) continue;
      for (const mapId of byLabel[label] || []) {
        (trainerText[mapId] ||= {})[idx] = {
          before: str(h.battle), won: str(h.won), after: str(h.after),
          event: typeof h.event === "string" ? h.event : "",
          sight: Number.isFinite(h.range) ? h.range : 0,
        };
      }
    }
  }
}

/* ----------------------------------------------------------------- emit -- */

const gamedata = {
  generatedAt: new Date().toISOString().slice(0, 10),
  romDerived: true,
  maps, tilesets, ids,
  sprites: raw.sprites || [],
  encounters: encounters || {},
  spriteSheets, facingPics, backPics, frameNames: FRAME_NAMES,
  npcText, trainerText, marts,
  // The SGB palette pack, as three tables: `order` (the ROM's own order),
  // `palettes` (name -> four RGB triples, lightest shade first) and `pokemon`
  // (species -> palette name), plus `cgbBase` for OG YELLOW. The battle preview
  // bakes a picture through one of these exactly like BattleState.getImage
  // does, so a modder can see what COLORS actually does to their art rather
  // than being told about it.
  palettes: palettes
    ? {
        order: palettes.order || [], palettes: palettes.palettes || {},
        pokemon: palettes.pokemon || {}, cgbBase: yellowCgb || null,
      }
    : null,
  // Full trainer records (party contents, not just the id list) so the NPC
  // workspace's battle step can show what a vanilla trainer actually fights
  // with, and default a new one's levels near theirs.
  trainers: trainers || {},
  // Full species records, for the same reason and two more: the Pokemon
  // workspace copies one as a starting point, and it works out what "normal"
  // base stats look like by measuring the 151 at runtime rather than carrying
  // a table of thresholds that would quietly rot.
  pokemon: Object.fromEntries(Object.entries(pokemon || {})
    .filter(([, r]) => r && typeof r === "object" && r.baseStats)
    .map(([id, { source, ...rest }]) => [id, rest])),
  monFront, monBack,
  // Full move records, for the same reason as the species ones: the Moves
  // workspace copies one as a starting point, and works out what normal power
  // and accuracy look like by measuring the game's own moves at runtime.
  moves: Object.fromEntries(Object.entries(moves || {})
    .filter(([, r]) => r && typeof r === "object" && r.type)
    .map(([id, { source, ...rest }]) => [id, rest])),
  // Full item records, for the same reason: the Items workspace copies one as
  // a starting point, and has to know a vanilla item's price, keyItem and
  // machine fields to do that honestly (most of what an item *does* is
  // hardcoded to its own id in the engine and does not live in these fields
  // at all -- see src/item.js for how the workspace handles that).
  items: Object.fromEntries(Object.entries(items || {})
    .filter(([, r]) => r && typeof r === "object" && r.price !== undefined)
    .map(([id, { source, ...rest }]) => [id, rest])),
  // Everything needed to PLAY a move animation, not merely name one.
  anims,
  // name -> the animated party icon's sheet; `iconByDex` is which shape each
  // of the 151 uses, so a new one can default to its neighbour's.
  iconArt,
  iconByDex: icons?.byDex || {},
  // Everything needed to PLAY a cry in the browser, rather than only name one.
  //
  // A Gen 1 cry is not a sound file: it is {base cry, pitch, length} pointing
  // at a short bytecode program in the ROM's sound banks, played through the
  // Game Boy's own sound chip. The engine already decodes those banks to one
  // 48 KB blob, so carrying it plus the per-species modifiers is enough for
  // src/cry.js to synthesize any cry -- including one this tool invents, which
  // no recording could ever cover.
  audio: audioBlob,
};

await writeFile(join(ROOT, "data/gamedata.json"), JSON.stringify(gamedata));

const px = Object.values(tilesets).reduce((n, t) => n + (t.png || "").length, 0);
console.log(`maps      : ${Object.keys(maps).length}`);
console.log(`tilesets  : ${Object.keys(tilesets).length} (${Math.round(px / 1024)} KB of tile sheets)`);
console.log(`encounters: ${Object.keys(gamedata.encounters).length} maps`);
console.log(`id lists  : ${Object.keys(ids).length} registries`);
for (const [k, v] of Object.entries(ids)) console.log(`   ${k.padEnd(18)} ${v.length}`);
const artKb = (o) => Math.round(Object.values(o).reduce((n, a) => n + a.png.length, 0) / 1024);
console.log(`art       : ${Object.keys(spriteSheets).length} overworld sheets (${artKb(spriteSheets)} KB), ` +
  `${Object.keys(facingPics).length} facing pics (${artKb(facingPics)} KB), ${Object.keys(backPics).length} back pics`);
console.log(`species   : ${Object.keys(gamedata.pokemon).length} records, ` +
  `${Object.keys(monFront).length} front pics (${artKb(monFront)} KB), ` +
  `${Object.keys(monBack).length} back pics (${artKb(monBack)} KB), ` +
  `${Object.keys(iconArt).length} menu icons`);
console.log(`cries     : ${audioBlob ? `${Object.keys(audioBlob.cries).length} playable (`
  + `${Math.round(audioBlob.programs.length / 1024)} KB of sound programs)` : "none (not playable)"}`);
console.log(`sounds    : ${Object.keys(audioBlob?.sfx || {}).length} sound effects`);
console.log(`animations: ${anims ? `${Object.keys(anims.moveAnims).length} move anims, `
  + `${Object.keys(anims.subanims).length} subanims, ${Object.keys(anims.frameBlocks).length} frame blocks, `
  + `${Object.keys(anims.tilesheets).length} tile sheets (`
  + `${Math.round(JSON.stringify(anims).length / 1024)} KB)` : "none"}`);
console.log(`moves     : ${Object.keys(gamedata.moves).length} records`);
console.log(`items     : ${Object.keys(gamedata.items).length} records`);
console.log(`marts     : ${Object.values(marts).reduce((n, l) => n + l.length, 0)} shopkeepers across ${Object.keys(marts).length} maps`);
console.log(`dialogue  : ${Object.values(npcText).reduce((n, m) => n + Object.keys(m).length, 0)} lines across ${Object.keys(npcText).length} maps`);
console.log(`trainers' : ${Object.values(trainerText).reduce((n, m) => n + Object.keys(m).length, 0)} before/won/after sets across ${Object.keys(trainerText).length} maps`);
if (!pokemon) console.log(`\n(no generated data found at ${dataDir} — dropdowns will fall back to text boxes)`);
