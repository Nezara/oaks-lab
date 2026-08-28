#!/usr/bin/env node
// Reads a hand-edited copy.md back against the live source and writes the
// changed lines into src/*.js -- the other half of extract-copy.mjs.
//
//   node tools/apply-copy.mjs         dry run: lists what would change
//   node tools/apply-copy.mjs --apply writes it, after backing up each
//                                     touched file to <file>.bak first
//
// Only entries whose text actually differs from the current source are
// touched. An id in copy.md that no longer exists in src/*.js (source
// changed since extraction, or a typo) is reported and skipped, never
// guessed at. An entry present in the source but missing from copy.md
// (a deleted line) is left alone -- this never deletes copy, only rewords it.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll } from "./extract-copy.mjs";
import { renderForSource } from "./copy-lib.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const apply = process.argv.includes("--apply");

function parseCopyMd(text) {
  const entries = new Map();
  const lines = text.split("\n");
  let id = null, body = [];
  const flush = () => {
    if (id) entries.set(id, body.join("\n").replace(/\n+$/, ""));
    id = null; body = [];
  };
  for (const line of lines) {
    const m = /^### \[([^\]]+)\]/.exec(line);
    if (m) { flush(); id = m[1]; continue; }
    if (/^## /.test(line)) { flush(); continue; }
    if (id) body.push(line);
  }
  flush();
  return entries;
}

const byFile = await extractAll();
const fresh = new Map();
for (const { entries } of byFile) for (const e of entries) fresh.set(e.id, e);

let copyMdText;
try {
  copyMdText = await readFile(join(ROOT, "copy.md"), "utf8");
} catch {
  console.error("copy.md not found -- run extract-copy.mjs first, edit it, then come back.");
  process.exit(1);
}
const edited = parseCopyMd(copyMdText);

const changes = []; // { entry, newText, newSource }
const holeWarnings = [];
const goneIds = [];
const mergedWarnings = [];

for (const [id, text] of edited) {
  const entry = fresh.get(id);
  if (!entry) { goneIds.push(id); continue; }
  if (text === entry.text) continue;
  if (text.includes("\n")) {
    // A legitimate edit is one line; this usually means the [id] header for
    // the *next* entry got deleted and its text ran on into this one rather
    // than wrapping on purpose. Refuse to guess which -- ask instead of
    // silently writing the merge into the wrong place in the source.
    mergedWarnings.push({ id, file: entry.file, line: entry.line });
    continue;
  }
  const rendered = renderForSource(entry.parts, text);
  if (rendered === null) { holeWarnings.push({ id, file: entry.file, line: entry.line }); continue; }
  changes.push({ entry, newText: text, newSource: rendered });
}

if (goneIds.length) {
  console.log(`${goneIds.length} id(s) in copy.md no longer match the source -- skipped:`);
  for (const id of goneIds) console.log(`  ${id}`);
}
if (holeWarnings.length) {
  console.log(`${holeWarnings.length} entr${holeWarnings.length === 1 ? "y" : "ies"} lost a live value (\${...}) and can't be applied -- skipped:`);
  for (const w of holeWarnings) console.log(`  ${w.file}:${w.line}`);
}
if (mergedWarnings.length) {
  console.log(`${mergedWarnings.length} entr${mergedWarnings.length === 1 ? "y spans" : "ies span"} more than one line -- skipped, most likely `
    + `an [id] header just below got deleted and its text ran into this entry instead of wrapping on purpose. `
    + `Check copy.md right after:`);
  for (const w of mergedWarnings) console.log(`  ${w.file}:${w.line}`);
}
if (!changes.length) {
  console.log("No text changes to apply.");
  process.exit(0);
}

console.log(`${changes.length} change${changes.length === 1 ? "" : "s"}${apply ? "" : " (dry run -- pass --apply to write)"}:\n`);
for (const c of changes) {
  console.log(`${c.entry.id}`);
  console.log(`  - ${c.entry.text}`);
  console.log(`  + ${c.newText}\n`);
}

if (!apply) process.exit(0);

const byFileChanges = new Map();
for (const c of changes) {
  if (!byFileChanges.has(c.entry.file)) byFileChanges.set(c.entry.file, []);
  byFileChanges.get(c.entry.file).push(c);
}

for (const [file, list] of byFileChanges) {
  const path = join(ROOT, file);
  let src = await readFile(path, "utf8");
  await writeFile(path + ".bak", src, "utf8");
  // Apply back-to-front so earlier offsets in the same file stay valid.
  list.sort((a, b) => b.entry.start - a.entry.start);
  for (const c of list) {
    src = src.slice(0, c.entry.start) + c.newSource + src.slice(c.entry.end);
  }
  await writeFile(path, src, "utf8");
  console.log(`wrote ${file}  (backup at ${file}.bak)`);
}
