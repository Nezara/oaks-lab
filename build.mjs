#!/usr/bin/env node
// Concatenate src/ into one self-contained oaks-lab.html, at the project
// root -- not a dist/ subfolder -- so "open the file" means the obvious file
// right there next to everything else, not a step of digging first.
//
// One file, no modules, no server: ES module imports are blocked over
// file://, and file:// is how this gets opened on a phone. The source stays
// split; only the build output is a single page.
//
//   node build.mjs               local build, game data embedded
//   node build.mjs --no-gamedata shareable build, no ROM-derived bytes
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFile(join(ROOT, p), "utf8");
const embedGamedata = !process.argv.includes("--no-gamedata");

const SOURCES = ["src/core.js", "src/script.js", "src/map.js", "src/zone.js", "src/wizard.js", "src/npc.js", "src/mon.js", "src/move.js", "src/item.js", "src/sprite.js", "src/cry.js", "src/ui.js"];

const js = (await Promise.all(SOURCES.map(async (f) => {
  const body = await read(f);
  return `/* ===== ${f} ===== */\n` + body.replace(/^"use strict";\n/, "");
}))).join("\n\n");

const pack = await read("data/schema-pack.json");
const css = await read("src/app.css");

// The pixel faces, base64'd by tools/build-fonts.mjs. Kept out of app.html
// so the source stays readable; a missing file is not fatal, the page just
// falls back to whatever the device has.
let fonts = "";
try {
  fonts = await read("data/fonts.css");
} catch {
  console.warn("no data/fonts.css -- building without the pixel fonts (run tools/build-fonts.mjs)");
}

let gamedata = "null";
if (embedGamedata) {
  try {
    gamedata = await read("data/gamedata.json");
  } catch {
    console.warn("no data/gamedata.json — building without it (run tools/extract-gamedata.mjs)");
  }
}

// A "</script>" anywhere in embedded JSON would close the tag early.
const safe = (s) => s.replace(/<\//g, "<\\/");

const html = (await read("src/app.html"))
  .split("__FONTS__").join(fonts)
  .split("__APP_CSS__").join(css)
  .split("__SCHEMA_PACK__").join(safe(pack))
  .split("__GAMEDATA__").join(safe(gamedata))
  .split("__APP_JS__").join('"use strict";\n' + js);

await writeFile(join(ROOT, "oaks-lab.html"), html);

console.log(`oaks-lab.html  ${(html.length / 1024).toFixed(0)} KB` +
  (embedGamedata && gamedata !== "null" ? "  (game data embedded — local use only)" : "  (no game data)"));
