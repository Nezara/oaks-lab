#!/usr/bin/env node
// Refresh the vendored wiki snapshots in data/wiki/.
// The registry reference is generated from the engine's src/mods/Schemas.lua,
// so re-running this after an engine release is how the schema pack stays current.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://raw.githubusercontent.com/wiki/bryanthaboi/gen1recomp";
const PAGES = [
  "Reference-Registries",
  "Reference-Commands",
  "Reference-Manifest",
  "Reference-Mod-Object",
  "Concepts-Registries",
  "Guide-Publishing",
  "Tutorial-06-NPC-And-Dialogue",
  "Tutorial-07-New-Map",
];

await mkdir(join(ROOT, "data/wiki"), { recursive: true });
for (const page of PAGES) {
  const res = await fetch(`${BASE}/${page}.md`);
  if (!res.ok) { console.error(`FAIL ${page}: ${res.status}`); continue; }
  const text = await res.text();
  await writeFile(join(ROOT, "data/wiki", `${page}.md`), text);
  console.log(`ok   ${page}.md  (${text.length} bytes)`);
}
