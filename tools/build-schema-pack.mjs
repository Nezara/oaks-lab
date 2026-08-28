#!/usr/bin/env node
// data/wiki/*.md  ->  data/schema-pack.json
//
// The schema pack is the tool's spine: every content form and every script
// node is generated from it, so adding engine coverage is a rebuild, not a
// code change. Reference-Registries.md is itself generated from the engine's
// src/mods/Schemas.lua, so this parse cannot silently drift from the engine.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(ROOT, p), "utf8");

/* ---------------------------------------------------------------- types --*/

// The generated docs use a small, regular type vocabulary. Twelve patterns
// cover all 40 registries; anything unrecognised falls back to a raw JSON
// field rather than being dropped, so a form is never a lie about coverage.
function parseType(raw) {
  const s = raw.trim();

  if (s.includes("|") && !s.startsWith("one of")) {
    const parts = splitTopLevel(s, "|").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const alts = parts.map(parseType);
      const primary = alts.find((a) => a.kind !== "lua") || alts[0];
      return { ...primary, alts: alts.map((a) => a.kind) };
    }
  }
  if (s.startsWith("one of ")) {
    const options = s.slice(7).split("|").map((o) => o.trim().replace(/^"|"$/g, "")).filter(Boolean);
    return { kind: "enum", options };
  }
  if (s.startsWith("list of ")) return { kind: "list", of: parseType(s.slice(8)) };
  if (s.startsWith("map of ")) {
    const [k, v] = splitTopLevel(s.slice(7), "->");
    return { kind: "map", key: parseType(k || "string"), value: parseType(v || "any value") };
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const fields = splitTopLevel(s.slice(1, -1), ",").map((f) => f.trim()).filter(Boolean);
    return {
      kind: "struct",
      fields: fields.map((f) => ({
        name: f.replace(/\?$/, ""),
        optional: f.endsWith("?"),
        type: { kind: "any" },
      })),
    };
  }

  let m;
  if ((m = s.match(/^integer\s*(-?\d+)\.\.(-?\d+)$/))) return { kind: "int", min: +m[1], max: +m[2] };
  if ((m = s.match(/^integer\s*>=\s*(-?\d+)$/)))        return { kind: "int", min: +m[1] };
  if ((m = s.match(/^number\s*([\d.]+)\.\.([\d.]+)$/))) return { kind: "number", min: +m[1], max: +m[2] };
  if (s === "integer")   return { kind: "int" };
  if (s === "number")    return { kind: "number" };
  if (s === "string")    return { kind: "string" };
  if (s === "boolean")   return { kind: "bool" };
  if (s === "file path") return { kind: "path" };
  if (s === "function")  return { kind: "lua" };   // not form-editable; needs the Lua pane
  if (s === "any value") return { kind: "any" };
  if ((m = s.match(/^(\w+)\s+id$/))) return { kind: "ref", registry: m[1] };

  return { kind: "any", raw: s };
}

// Split on a separator that is not nested inside braces or quotes.
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && s.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/* ----------------------------------------------------------- registries --*/

function parseRegistries(md) {
  const registries = {};
  // Gen 2 subsections repeat the field table for a different record. The
  // prototype targets Gen 1, so everything from "### On Gold" to the next
  // "## " heading is skipped.
  const sections = md.split(/\n## /).slice(1);

  for (const section of sections) {
    const nl = section.indexOf("\n");
    const name = section.slice(0, nl).trim();
    if (!/^[a-z_0-9]+$/.test(name)) continue;            // skips the "v1 aliases" section
    const gen1 = section.slice(nl).split(/\n### /)[0];

    const reg = { id: name, fields: {}, order: [] };
    let m;
    if ((m = gen1.match(/^- semantics: `(\w+)`/m)))   reg.semantics = m[1];
    if ((m = gen1.match(/^- target: `?([\w.]+)`?/m))) reg.target = m[1];
    if ((m = gen1.match(/^- value: (.+)$/m)))         reg.value = m[1].trim();
    if (/^- \*\*deprecated\*\*/m.test(gen1))          reg.deprecated = true;
    if ((m = gen1.match(/```lua\n([\s\S]*?)```/)))    reg.example = m[1].trim();

    for (const line of gen1.split("\n")) {
      const row = line.match(/^\|\s*`(\w+)`\s*\|(.+)\|\s*(yes|no)\s*\|\s*$/);
      if (!row) continue;
      reg.fields[row[1]] = { name: row[1], type: parseType(row[2]), required: row[3] === "yes" };
      reg.order.push(row[1]);
    }
    // Registries with a "- value:" line and no field table take a whole
    // value, not a record of fields (map_songs, map_scripts, battle_anims).
    if (!reg.order.length && reg.value) reg.valueType = parseType(reg.value);
    registries[name] = reg;
  }
  return registries;
}

/* ------------------------------------------------------------- commands --*/

// Argument names come from the generated table; this overlay adds types and
// plain-English labels for the verbs a beginner actually reaches for. A verb
// with no overlay still works -- its args render as plain text boxes.
const OVERLAY = {
  show_text:      { label: "Say something",       args: [{ name: "textId", type: { kind: "text" }, label: "Text" }] },
  ask:            { label: "Ask yes / no",        check: true, args: [{ name: "textId", type: { kind: "text" }, label: "Question" }] },
  choice:         { label: "Menu choice",         check: true, args: [{ name: "labels", type: { kind: "list", of: { kind: "string" } }, label: "Options" }] },
  set_flag:       { label: "Set flag",            args: [{ name: "name", type: { kind: "string" }, label: "Flag" }] },
  clear_flag:     { label: "Clear flag",          args: [{ name: "name", type: { kind: "string" }, label: "Flag" }] },
  check_flag:     { label: "Is flag set?",        check: true, args: [{ name: "name", type: { kind: "string" }, label: "Flag" }] },
  check_item:     { label: "Has item?",           check: true, args: [{ name: "itemId", type: { kind: "ref", registry: "items" }, label: "Item" }] },
  give_item:      { label: "Give item",           args: [{ name: "itemId", type: { kind: "ref", registry: "items" }, label: "Item" }, { name: "count", type: { kind: "int", min: 1 }, label: "How many", default: 1 }] },
  take_item:      { label: "Take item",           args: [{ name: "itemId", type: { kind: "ref", registry: "items" }, label: "Item" }, { name: "count", type: { kind: "int", min: 1 }, label: "How many", default: 1 }] },
  give_money:     { label: "Give money",          args: [{ name: "amount", type: { kind: "int", min: 0 }, label: "Amount" }] },
  give_pokemon:   { label: "Give a Pokemon",      check: true, args: [{ name: "species", type: { kind: "ref", registry: "pokemon" }, label: "Species" }, { name: "level", type: { kind: "int", min: 1, max: 100 }, label: "Level", default: 5 }] },
  heal_party:     { label: "Heal the party",      args: [] },
  mark_seen:      { label: "Mark seen in dex",    args: [{ name: "species", type: { kind: "ref", registry: "pokemon" }, label: "Species" }] },
  start_battle:   { label: "Start a battle",      args: [{ name: "kind", type: { kind: "enum", options: ["wild", "trainer"] }, label: "Kind", default: "wild" }, { name: "who", type: { kind: "string" }, label: "Species / trainer class" }, { name: "levelOrParty", type: { kind: "int", min: 1 }, label: "Level / party index", default: 5 }] },
  check_battle_result: { label: "Did the player win?", check: true, args: [{ name: "result", type: { kind: "enum", options: ["win", "lose", "run", "caught"] }, label: "Result", default: "win" }] },
  face_player:    { label: "Face the player",     args: [] },
  face_npc:       { label: "Player faces me",     args: [] },
  face:           { label: "Turn to face",        args: [{ name: "dir", type: { kind: "enum", options: ["up", "down", "left", "right"] }, label: "Direction", default: "down" }] },
  move_player:    { label: "Walk the player",     args: [{ name: "dir", type: { kind: "enum", options: ["up", "down", "left", "right"] }, label: "Direction", default: "down" }, { name: "tiles", type: { kind: "int", min: 1 }, label: "Steps", default: 1 }] },
  move_npc:       { label: "Walk an NPC",         args: [{ name: "objIndex", type: { kind: "int", min: 0 }, label: "NPC index" }, { name: "dir", type: { kind: "enum", options: ["up", "down", "left", "right"] }, label: "Direction", default: "down" }, { name: "tiles", type: { kind: "int", min: 1 }, label: "Steps", default: 1 }] },
  emote:          { label: "Emote bubble",        args: [{ name: "target", type: { kind: "string" }, label: "Target", default: "player" }, { name: "bubble", type: { kind: "enum", options: ["shock", "question", "happy"] }, label: "Bubble", default: "shock" }, { name: "frames", type: { kind: "int", min: 1 }, label: "Frames", default: 30 }] },
  warp:           { label: "Warp somewhere",      args: [{ name: "mapId", type: { kind: "ref", registry: "maps" }, label: "Map" }, { name: "x", type: { kind: "int", min: 0 }, label: "X" }, { name: "y", type: { kind: "int", min: 0 }, label: "Y" }, { name: "facing", type: { kind: "enum", options: ["up", "down", "left", "right"] }, label: "Facing", default: "down" }] },
  play_sound:     { label: "Play a sound",        args: [{ name: "soundId", type: { kind: "string" }, label: "Sound" }] },
  play_cry:       { label: "Play a cry",          args: [{ name: "species", type: { kind: "ref", registry: "pokemon" }, label: "Species" }] },
  play_music:     { label: "Change music",        args: [{ name: "songId", type: { kind: "string" }, label: "Song" }] },
  fade:           { label: "Fade the screen",     args: [{ name: "dir", type: { kind: "enum", options: ["out", "in"] }, label: "Direction", default: "out" }, { name: "frames", type: { kind: "int", min: 1 }, label: "Frames", default: 16 }] },
  wait:           { label: "Wait",                args: [{ name: "frames", type: { kind: "int", min: 1 }, label: "Frames", default: 30 }] },
  wait_flag:      { label: "Wait for a flag",     check: true, args: [{ name: "flagName", type: { kind: "string" }, label: "Flag" }, { name: "timeoutFrames", type: { kind: "int", min: 1 }, label: "Timeout", default: 300 }] },
  check_dex_owned: { label: "Owns N species?",    check: true, args: [{ name: "n", type: { kind: "int", min: 1 }, label: "How many", default: 1 }] },
  replace_block:  { label: "Replace a block",     args: [{ name: "bx", type: { kind: "int", min: 0 }, label: "Block X" }, { name: "by", type: { kind: "int", min: 0 }, label: "Block Y" }, { name: "blockId", type: { kind: "int", min: 0, max: 255 }, label: "New block" }] },
};

// Verbs offered by default. Everything else sits behind "show all verbs" --
// the ladder from novice to the full engine surface is a checkbox, not a
// different tool.
const STARTER = [
  "show_text", "ask", "set_flag", "clear_flag", "check_flag", "give_item", "check_item",
  "face_player", "give_pokemon", "start_battle", "check_battle_result",
  "heal_party", "warp", "play_sound", "emote", "move_player", "wait",
];

function parseCommands(md) {
  const commands = {};
  const sections = md.split(/\n## /).slice(1);

  for (const section of sections) {
    const nl = section.indexOf("\n");
    const category = section.slice(0, nl).trim();
    if (category.startsWith("Registering")) continue;

    for (const line of section.split("\n")) {
      if (/^\s*\|\s*-+/.test(line)) continue;
      const row = line.match(/^\|\s*(`[^|]+`(?:\s*\/\s*`[^|]+`)*)\s*\|([^|]*)\|(.+)\|\s*$/);
      if (!row) continue;

      const verbs = [...row[1].matchAll(/`(\w+)`/g)].map((m) => m[1]);
      const argNames = [...row[2].matchAll(/`([^`]+)`/g)]
        .flatMap((m) => m[1].split(","))
        .map((a) => a.trim())
        .filter((a) => /^[a-zA-Z]\w*$/.test(a));
      const does = row[3].trim();

      for (const verb of verbs) {
        const overlay = OVERLAY[verb] || {};
        commands[verb] = {
          verb,
          category,
          does,
          label: overlay.label || verb.replace(/_/g, " "),
          check: !!overlay.check,
          starter: STARTER.includes(verb),
          curated: !!OVERLAY[verb],
          args: overlay.args || argNames.map((n) => ({ name: n, type: { kind: "string" }, label: n })),
        };
      }
    }
  }
  return commands;
}

/* ------------------------------------------------------------- manifest --*/

function parseManifest(md) {
  const fields = [];
  for (const line of md.split("\n")) {
    if (/^\s*\|\s*-+/.test(line)) continue;
    const row = line.match(/^\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/);
    if (!row) continue;
    fields.push({
      name: row[1],
      type: row[2],
      default: row[3].replace(/`/g, ""),
      required: /required/.test(row[3]),
      doc: row[4],
    });
    if (fields.length >= 28) break;   // the Fields table only; later tables are ranges and deps
  }
  return fields;
}

/* ------------------------------------------------------------------ run --*/

const registries = parseRegistries(await read("data/wiki/Reference-Registries.md"));
const commands = parseCommands(await read("data/wiki/Reference-Commands.md"));
const manifest = parseManifest(await read("data/wiki/Reference-Manifest.md"));

const pack = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "github.com/bryanthaboi/gen1recomp/wiki",
  modApi: 2,
  registries,
  commands,
  manifest,
  // What the Content tab offers first. The rest stay one checkbox away.
  starterRegistries: ["pokemon", "moves", "items", "trainers", "maps", "map_scripts", "encounters", "map_songs"],
};

await writeFile(join(ROOT, "data/schema-pack.json"), JSON.stringify(pack, null, 1));

const fieldCount = Object.values(registries).reduce((n, r) => n + r.order.length, 0);
const unknown = new Set();
for (const r of Object.values(registries))
  for (const f of Object.values(r.fields)) if (f.type.raw) unknown.add(f.type.raw);

console.log(`registries : ${Object.keys(registries).length} (${fieldCount} fields)`);
console.log(`commands   : ${Object.keys(commands).length} (${Object.values(commands).filter((c) => c.curated).length} curated, ${Object.values(commands).filter((c) => c.check).length} branching)`);
console.log(`manifest   : ${manifest.length} fields`);
if (unknown.size) console.log(`unparsed types (fall back to raw JSON): ${[...unknown].join("  |  ")}`);
