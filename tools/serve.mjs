#!/usr/bin/env node
// Tiny static server for the project root -- only needed to preview in a
// desktop browser that blocks file://. The built page itself needs no server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript" };
const PORT = Number(process.env.PORT || 4173);

createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  const file = join(ROOT, path === "/" ? "oaks-lab.html" : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`Oak's Lab on http://localhost:${PORT}`));
