"use strict";
/* ============================================================================
   Oak's Lab sprites — turning any sheet somebody found into one the engine
   can draw.

   What the engine actually accepts (`sprites` registry, and confirmed against
   a shipping mod's generated art):

     frameWidth / frameHeight   any integer >= 1, not 16 -- the true_size
                                follower packs run 16x15 up to 39x26
     anchorX / anchorY          the contact point, fractional allowed. The
                                convention those packs use is anchorX = half
                                the frame (centred) and anchorY = the frame
                                height (feet flush on the tile); a floating
                                thing pulls anchorY in a few pixels
     frames                     required, and the sheet must be a VERTICAL
                                STRIP: one frame wide, `frames` tall. Checked:
                                a 6-frame 22x24 follower ships as a 22x144 PNG
     trueColor                  ship the art as-is instead of letting the
                                engine put it through its own palette

   So frame SIZE is free and frame LAYOUT is not. That is the whole design of
   this module: let the user import any layout at all -- a 4x4 grid, a packed
   atlas, a row of poses -- say which shape is which pose, and then re-pack
   the result into the strip the engine wants. The sheet the user brought and
   the sheet the mod ships stop being the same file, and "what does my PNG
   have to look like" stops being a question they have to answer.
   ========================================================================== */

/* ------------------------------------------------------- pixel plumbing -- */

function imageFromB64(b64) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("not an image this browser can read"));
    img.src = "data:image/png;base64," + b64;
  });
}

// Every operation below works on one mutable canvas rather than passing
// base64 around: re-encoding a PNG per edit would be pointless work, and
// finding frames wants raw pixels anyway.
function canvasOf(img) {
  const cv = el("canvas", { width: img.naturalWidth, height: img.naturalHeight });
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = false;
  c.drawImage(img, 0, 0);
  return cv;
}

const pngOf = (cv) => cv.toDataURL("image/png").split(",")[1];

const ALPHA_MIN = 8;             // below this a pixel counts as "not there"

function knockOutColour(cv, r0, g0, b0, tol) {
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(0, 0, cv.width, cv.height);
  const p = d.data;
  const t = tol * tol * 3;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < ALPHA_MIN) continue;
    const dr = p[i] - r0, dg = p[i + 1] - g0, db = p[i + 2] - b0;
    if (dr * dr + dg * dg + db * db <= t) p[i + 3] = 0;
  }
  c.putImageData(d, 0, 0);
}

/**
 * Knock out a flat background colour, if the sheet obviously has one.
 *
 * Sheets ripped from old games or pulled off a sprite site routinely use a
 * flat magenta/white/cyan background instead of an alpha channel, and finding
 * frames keys entirely off alpha -- a fully opaque sheet can only ever come
 * back as one island covering everything. Running this on load rather than
 * behind a button is what makes those sheets just work.
 *
 * Two of the four corners have to agree before anything is removed. A sheet
 * whose corners disagree is not obviously background-on-a-colour, and
 * guessing wrong there would eat real art.
 */
function autoKnockBackground(cv) {
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(0, 0, cv.width, cv.height);
  const p = d.data;
  for (let i = 3; i < p.length; i += 4) if (p[i] < ALPHA_MIN) return false;

  const w = cv.width, h = cv.height;
  const at = (x, y) => { const i = (y * w + x) * 4; return `${p[i]},${p[i + 1]},${p[i + 2]}`; };
  const tally = {};
  for (const k of [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]) {
    tally[k] = (tally[k] || 0) + 1;
  }
  const [best, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (n < 2) return false;
  const [r, g, b] = best.split(",").map(Number);
  knockOutColour(cv, r, g, b, 24);
  return true;
}

// Same idea as knockOutColour, but confined to one box -- so it can clear a
// background inside a hand-drawn region without touching a colour that is
// legitimate art anywhere else on the sheet.
function knockOutColourInBox(cv, box, r0, g0, b0, tol) {
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(box.x, box.y, box.w, box.h);
  const p = d.data;
  const t = tol * tol * 3;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < ALPHA_MIN) continue;
    const dr = p[i] - r0, dg = p[i + 1] - g0, db = p[i + 2] - b0;
    if (dr * dr + dg * dg + db * db <= t) p[i + 3] = 0;
  }
  c.putImageData(d, box.x, box.y);
}

/**
 * The background-knockout autoKnockBackground does for a freshly loaded
 * sheet, but scoped to one box drawn in "specify sprite" mode.
 *
 * The whole-sheet pass only fires when the sheet is uniformly opaque and its
 * four corners agree -- a sheet with a different background colour behind
 * each sprite, or content sitting in a corner, fails that and stays fully
 * opaque. When somebody then boxes one sprite by hand, the box would come
 * back as-drawn, background included, with nothing left to trim it down.
 * This runs the identical two-corners-agree rule against just the box's own
 * corners, so a region that still has no alpha of its own gets one before
 * `shapeInRegion` goes looking for where the ink actually ends. A box whose
 * corners already carry real transparency is left alone -- the sheet's own
 * import already dealt with it, and there is nothing here to remove.
 */
function autoKnockBoxBackground(cv, box) {
  if (box.w < 2 || box.h < 2) return false;
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(box.x, box.y, box.w, box.h);
  const p = d.data;
  for (let i = 3; i < p.length; i += 4) if (p[i] < ALPHA_MIN) return false;

  const w = box.w, h = box.h;
  const at = (x, y) => { const i = (y * w + x) * 4; return `${p[i]},${p[i + 1]},${p[i + 2]}`; };
  const tally = {};
  for (const k of [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]) {
    tally[k] = (tally[k] || 0) + 1;
  }
  const [best, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (n < 2) return false;
  const [r, g, b] = best.split(",").map(Number);
  knockOutColourInBox(cv, box, r, g, b, 24);
  return true;
}

/**
 * Flatten to luminance, keeping alpha.
 *
 * The point is not the grey -- it is handing the engine art with no colour
 * opinion of its own, so its palette system is free to apply whatever
 * palette the map and the time of day call for. That is why choosing this
 * also drops `trueColor` from the exported record.
 */
function toGreyscale(cv) {
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(0, 0, cv.width, cv.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < ALPHA_MIN) { p[i + 3] = 0; continue; }
    const lum = Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]);
    p[i] = p[i + 1] = p[i + 2] = lum;
  }
  c.putImageData(d, 0, 0);
}

/* -------------------------------------------------------- finding frames -- */

/**
 * Frames as connected blobs of ink.
 *
 * This is the only finder, because it is the one that does not care how the
 * sheet is laid out: a grid, a packed atlas, a single row and a hand-drawn
 * mess all come back the same way, with bounds already tight to the art.
 * Eight-connected, so a diagonal antialiased edge does not split one sprite
 * in two; blobs below `minPx` are dropped, since a stray pixel of leftover
 * compression noise is not a frame.
 */
/**
 * The colour Oak's Lab draws cell guides in when it exports a filmstrip.
 *
 * Battle art is four greys plus transparency, so a saturated magenta cannot
 * collide with anything real -- and keying on magenta is a convention
 * spritework already has, so it reads as a guide rather than as art.
 */
const GUIDE_RGB = [255, 0, 255];

/**
 * Read a filmstrip's cells straight off its guide lines.
 *
 * An exported strip is drawn as a boxed grid, and those boxes are exactly
 * the information the importer needs -- so rather than the strip carrying
 * its cell size in a filename (lost the moment anybody renames it) or being
 * re-guessed by island detection (which splits one frame drawn in two
 * pieces, and merges two frames that touch), the grid is simply read back.
 *
 * A guide row is one whose every pixel is the guide colour; likewise a
 * column. The cells are the spans between them. Returns null when the sheet
 * has no guides, which is every sheet that did not come from here.
 */
function guideGridBoxes(data, w, h) {
  const p = data.data;
  const [gr, gg, gb] = GUIDE_RGB;
  const isGuide = (x, y) => {
    const i = (y * w + x) * 4;
    return p[i + 3] > 200 && Math.abs(p[i] - gr) < 40
      && Math.abs(p[i + 1] - gg) < 40 && Math.abs(p[i + 2] - gb) < 40;
  };

  const rows = [];
  for (let y = 0; y < h; y++) {
    let all = true;
    for (let x = 0; x < w; x++) if (!isGuide(x, y)) { all = false; break; }
    if (all) rows.push(y);
  }
  if (rows.length < 2) return null;

  const cols = [];
  for (let x = 0; x < w; x++) {
    let all = true;
    for (let y = 0; y < h; y++) if (!isGuide(x, y)) { all = false; break; }
    if (all) cols.push(x);
  }
  // Side borders are optional: a strip cropped down the middle still has its
  // horizontal rules, and those alone are enough to cut it into frames.
  const x0 = cols.length ? cols[0] + 1 : 0;
  const x1 = cols.length > 1 ? cols[cols.length - 1] : w;

  const boxes = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const top = rows[i] + 1, bottom = rows[i + 1];
    if (bottom - top < 1 || x1 - x0 < 1) continue;
    boxes.push({ x: x0, y: top, w: x1 - x0, h: bottom - top });
  }
  return boxes.length ? boxes : null;
}

function framesByIslands(data, w, h, minPx = 12, region = null) {
  const p = data.data;
  // A region confines the search to a box the user drew round one sprite --
  // the same finder, just not allowed to wander out of it.
  const rx0 = region ? Math.max(0, region.x) : 0;
  const ry0 = region ? Math.max(0, region.y) : 0;
  const rx1 = region ? Math.min(w, region.x + region.w) : w;
  const ry1 = region ? Math.min(h, region.y + region.h) : h;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let sy = ry0; sy < ry1; sy++) for (let sx = rx0; sx < rx1; sx++) {
    const i = sy * w + sx;
    if (seen[i] || p[i * 4 + 3] < ALPHA_MIN) continue;
    let minX = w, minY = h, maxX = -1, maxY = -1, n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const at = stack.pop();
      const x = at % w, y = (at - x) / w;
      n++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < rx0 || ny < ry0 || nx >= rx1 || ny >= ry1) continue;
          const ni = ny * w + nx;
          if (seen[ni] || p[ni * 4 + 3] < ALPHA_MIN) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (n >= minPx) out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return out;
}

// Reading order, so frame 1 is the one at the top left. Rows first, with a
// tolerance, or a sheet whose sprites sit a pixel or two off each other
// reads as a zigzag.
function sortBoxes(boxes) {
  if (!boxes.length) return boxes;
  const rowTol = Math.max(4, Math.min(...boxes.map((b) => b.h)) / 2);
  return boxes.slice().sort((a, b) =>
    (Math.abs(a.y - b.y) > rowTol ? a.y - b.y : a.x - b.x));
}

/**
 * The ink inside a box the user drew, tight to the art.
 *
 * The escape hatch for when the automatic pass goes wrong: a sheet whose
 * sprites touch comes back as one island, a noisy one comes back as fifty.
 * The user says where the sprite is, and this does to that box what the
 * finder does to the whole sheet -- everything in it that is not a speck,
 * unioned, so the result is one frame trimmed to its own edges rather than
 * wherever the drag happened to stop. A box with nothing in it is nothing,
 * not an empty frame.
 */
function shapeInRegion(data, w, h, box) {
  let isl = framesByIslands(data, w, h, 12, box);
  if (!isl.length) isl = framesByIslands(data, w, h, 1, box);
  if (!isl.length) return null;
  const x0 = Math.min(...isl.map((b) => b.x));
  const y0 = Math.min(...isl.map((b) => b.y));
  const x1 = Math.max(...isl.map((b) => b.x + b.w));
  const y1 = Math.max(...isl.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* -------------------------------------------------------------- packing -- */

/**
 * The frames the user picked, in the order they picked them, as the vertical
 * strip the engine reads.
 *
 * Cells can be all different sizes -- an island finder on a hand-drawn sheet
 * basically guarantees it -- so the strip's frame box is the largest of them
 * and each cell is placed centred left-to-right and sitting on the bottom
 * edge. Bottom-aligned is what keeps a walk cycle's feet from bouncing, and
 * it is the same thing anchorY = frameHeight is saying.
 */
function packStrip(srcCv, boxes) {
  const fw = Math.max(...boxes.map((b) => b.w));
  const fh = Math.max(...boxes.map((b) => b.h));
  const cv = el("canvas", { width: fw, height: fh * boxes.length });
  const c = cv.getContext("2d");
  c.imageSmoothingEnabled = false;
  boxes.forEach((b, i) => {
    c.drawImage(srcCv, b.x, b.y, b.w, b.h,
      Math.round((fw - b.w) / 2), i * fh + (fh - b.h), b.w, b.h);
  });
  return { cv, png: pngOf(cv), w: fw, h: fh * boxes.length, frameW: fw, frameH: fh, frames: boxes.length };
}

// The engine has three overworld shapes and no others, so a sheet is read as
// the longest one the user actually filled in from the top. Six slots are
// always offered because walking is the common case; three of them filled is
// a perfectly good NPC who stands and turns, and one is a statue.
const POSE_SHAPES = [[6, "walks"], [3, "stands and turns"], [1, "one pose"]];

// A menu icon is a two-frame blink/bob loop, not a walking pose -- its own
// tiny shape list so mode:"icon" can share the rest of the studio (packing,
// stand-in/ignore logic) instead of forking a second copy of it.
const ICON_SHAPES = [[2, "the two icon frames"], [1, "one still frame"]];

// How far the sheet view can be zoomed, in either direction. A sheet with
// 8px frames needs to get much bigger than one already imported at 64px, so
// this goes well past what the auto zoom on load ever picks.
const ZOOM_MIN = 1, ZOOM_MAX = 16;

/* --------------------------------------------------------- battle mock -- */

/* The Game Boy screen, in its own pixels. Everything below is placed in
   these coordinates and blown up at the end with smoothing off, so the mock
   comes out as pixel art rather than a smooth drawing of pixel art. */
const GB_W = 160, GB_H = 144;

/* The four DMG shades, lightest first -- PaletteFX.GRAYS, and the shades the
   engine's own extracted art is drawn in. The screen furniture below is
   painted in these; "Black and white" (below) bakes a picture into the same
   four so it reads as the plain Game Boy would show it, uncoloured. */
const DMG = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];
const rgbOf = (c) => "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";

/* Where Gen 1 puts the two pictures, and at what scale with nothing
   overriding it -- BattleState.BATTLE_SCALE_DEFAULT = { front = 1, back = 2 }.
   The enemy's is 7x7 tiles up in the top right, drawn 1:1. The player's is
   drawn TWICE its native size bottom left -- which is exactly why RBY back
   sprites look soft next to everything else on the screen, and why a back
   sprite wants to be 32px when a facing one wants to be 56. */
const BATTLE_ENEMY = { x: 96, y: 0, w: 56, h: 56, scale: 1 };
const BATTLE_PLAYER = { x: 8, y: 48, w: 48, h: 48, scale: 2 };

// BattleState.resolveBattleScale's own fallback, keyed the same way the
// studio's o.battle is -- what a picture is scaled at when nothing overrides
// it. A trainer/back pic overrides through a path-keyed battle_sprite_scales
// record (not a species field, since these pics are not species-keyed).
const BATTLE_SCALE_DEFAULT = { facing: 1, back: 2 };

/* ------------------------------------------------------- battle colour -- */

/* This preview shows what a battle picture looks like under the Super Game
   Boy colours (SGB), the mode the port's COLORS option starts on. Whether it
   gets coloured at all is the same choice as the sprite's own trueColor flag:
   the engine only skips the bake for the one mode that honours trueColor
   (ADVANCED); every other mode -- SGB included -- bakes trueColor art through
   a palette exactly like non-trueColor art. So "as imported" here previews
   art shipped untouched, and "colour palette" previews art the engine will
   tint, with a picker for which named palette it lands under. */

/* What a person's battle pictures actually get. BattleState hands a trainer's
   front pic and the player's back pic PAL_MEWMON and nothing else -- the
   per-species names are for Pokemon pics. They are all offered anyway,
   because trying BROWNMON on a drawing is the one way to see what a palette
   really does to it. */
const BATTLE_PAL_DEFAULT = "MEWMON";

// Not a real palette name -- picking this bakes the four DMG shades instead
// of a named colour, i.e. what the picture looks like completely uncoloured.
// Needs no game data, so it is always on the list.
const BW_PAL = "__bw__";

// The ten palettes the ROM actually hands out to species -- what a battle
// picture can be baked through in the real game (BattleState.monPal picks one
// of these, or MEWMON). The other ~27 names in the SGB pack are map and menu
// palettes (ROUTE, CAVE, SLOTS1..4, BADGE, GAMEFREAK...) that no battle
// picture is ever tinted with, so they do not belong in this picker even
// though the table technically has them.
const MON_PAL_ORDER = ["MEWMON", "BLUEMON", "REDMON", "CYANMON", "PURPLEMON",
  "BROWNMON", "GREENMON", "PINKMON", "YELLOWMON", "GRAYMON"];

function palColours(name) {
  if (name === BW_PAL) return DMG;
  const pack = GAME?.palettes?.palettes;
  if (!pack) return null;
  return pack[name] || pack[BATTLE_PAL_DEFAULT] || null;
}

/**
 * Bucket a canvas into four colours the way the engine does.
 *
 * By the RED CHANNEL, not by brightness: BattleState.getImage's mapPixel
 * reads `r > 0.83 / 0.5 / 0.17` and looks at nothing else, and so does the
 * shade shader. That is why a blue drawing comes out of this almost entirely
 * dark -- a thing worth seeing rather than being told.
 */
function bakePalette(cv, colours) {
  const c = cv.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(0, 0, cv.width, cv.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] === 0) continue;
    const col = colours[p[i] > 211 ? 0 : p[i] > 127 ? 1 : p[i] > 43 ? 2 : 3];
    p[i] = col[0]; p[i + 1] = col[1]; p[i + 2] = col[2];
  }
  c.putImageData(d, 0, 0);
}

/**
 * What this picture would actually look like in a battle.
 *
 * "Any size works" is true and also the least useful thing to tell somebody
 * holding a 96px drawing: the engine will happily accept it and then it will
 * cover half the screen. So rather than describe the sizes, this draws the
 * screen -- the two status boxes, the text box, and the picture sitting where
 * the engine puts it, at the scale the engine draws it, clipped by the same
 * 160x144 the player is looking at. A picture that is too big is not a
 * warning to read, it is a thing overlapping the text box.
 *
 * The same goes for colour: the picture is baked through `o.pal` -- one of the
 * ROM's SGB palettes -- exactly as BattleState.getImage would, rather than
 * being shown in whatever it happened to be painted in.
 *
 * Deliberately furniture, not a screenshot: enough of the frame for the eye
 * to read it as a battle, and no pretence that the rest of it is accurate.
 */
/**
 * The static battle-screen furniture, with no Pokemon pictures: the two name
 * boxes with their HP bars filled in, dashed ghost slots standing in for
 * where the pictures would sit, and the message box with real text in it.
 *
 * `battleMock` below draws all of this too, folded into its own picture-
 * placing logic. This is the same look pulled out on its own for callers
 * that only need a battle screen to sit something ELSE on top of -- a move
 * preview has no Pokemon to show, and a plain box outline with nothing else
 * in it reads as broken rather than as "furniture," which is the whole
 * reason this exists as its own function instead of every such caller
 * inventing its own thinner version.
 */
function drawBattleChrome(c, name, message) {
  // The Game Boy screen is white everywhere, not just inside the boxes --
  // left unfilled, the gaps around them would show whatever the page behind
  // the canvas happens to be (dark in dark mode), which reads as broken
  // rather than as a battle screen.
  c.fillStyle = rgbOf(DMG[0]);
  c.fillRect(0, 0, GB_W, GB_H);

  const box = (x, y, w, h) => {
    c.fillStyle = rgbOf(DMG[0]);
    c.fillRect(x, y, w, h);
    c.strokeStyle = rgbOf(DMG[3]);
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };
  const say = (t, x, y) => {
    c.fillStyle = rgbOf(DMG[3]);
    c.font = "6px ui-monospace, monospace";
    c.fillText(String(t).toUpperCase(), x, y);
  };
  const hpbar = (x, y, w) => {
    c.strokeStyle = rgbOf(DMG[3]);
    c.strokeRect(x + 0.5, y + 0.5, w, 3);
    c.fillStyle = rgbOf(DMG[2]);
    c.fillRect(x + 1, y + 1, w - 1, 2);
  };
  const ghost = (slot) => {
    c.save();
    c.strokeStyle = rgbOf(DMG[1]);
    c.setLineDash([2, 2]);
    c.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
    c.restore();
  };

  box(4, 14, 84, 26);
  say(name, 8, 24);
  hpbar(8, 30, 60);

  box(74, 58, 82, 30);
  say("you", 78, 68);
  hpbar(78, 74, 60);

  ghost(BATTLE_ENEMY);
  ghost(BATTLE_PLAYER);

  box(0, 96, GB_W, 48);
  if (message) say(message, 8, 112);
}

function battleMock(o) {
  const scale = o.scale || 2;
  const pal = o.pal || palColours(battleView.pal);
  const cv = el("canvas", { class: "battlemock", width: GB_W * scale, height: GB_H * scale });
  cv.style.width = (GB_W * scale) + "px";
  cv.style.height = (GB_H * scale) + "px";
  const off = el("canvas", { width: GB_W, height: GB_H });

  // The studio hands over a live canvas it is still editing; the NPC form
  // hands over a stored PNG. Both end up as something drawImage takes.
  const sourceOf = (a) => {
    if (!a) return null;
    const tc = !!a.trueColor;
    if (a.cv) return { img: a.cv, w: a.cv.width, h: a.cv.height, live: true, trueColor: tc, scale: a.scale };
    return { img: artImage(a.key, a.png), w: a.w, h: a.h, live: false, trueColor: tc, scale: a.scale };
  };
  const front = sourceOf(o.facing);
  const back = sourceOf(o.back);

  const c = off.getContext("2d", { willReadFrequently: true });

  const box = (x, y, w, h) => {
    c.fillStyle = rgbOf(DMG[0]);
    c.fillRect(x, y, w, h);
    c.strokeStyle = rgbOf(DMG[3]);
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };
  const say = (t, x, y) => {
    c.fillStyle = rgbOf(DMG[3]);
    c.font = "6px ui-monospace, monospace";
    c.fillText(String(t).toUpperCase(), x, y);
  };
  const hpbar = (x, y, w) => {
    c.strokeStyle = rgbOf(DMG[3]);
    c.strokeRect(x + 0.5, y + 0.5, w, 3);
    c.fillStyle = rgbOf(DMG[2]);
    c.fillRect(x + 1, y + 1, w - 1, 2);
  };

  // A slot with nothing in it yet, so the shape of what is missing is still
  // visible rather than the screen just looking empty there.
  const ghost = (slot) => {
    c.save();
    c.strokeStyle = rgbOf(DMG[1]);
    c.setLineDash([2, 2]);
    c.strokeRect(slot.x + 0.5, slot.y + 0.5, slot.w - 1, slot.h - 1);
    c.restore();
  };

  // The picture as SGB loads it: baked through the palette. Copied first,
  // because the caller owns the canvas this came from and is still editing it.
  const baked = (src) => {
    // "As imported" -- shipped trueColor, so nothing here bakes it (only
    // ADVANCED honours that flag in the real game, and SGB does not, but
    // showing it untouched is the whole point of "as imported": it is what
    // you painted, not what SGB would actually do to it).
    if (src.trueColor || !pal) return src.img;
    const s = el("canvas", { width: src.w, height: src.h });
    const sc = s.getContext("2d", { willReadFrequently: true });
    sc.imageSmoothingEnabled = false;
    sc.drawImage(src.img, 0, 0, src.w, src.h);
    bakePalette(s, pal);
    return s;
  };

  // Centred left-to-right in its slot and standing on the slot's bottom
  // edge, which is how both of Gen 1's pictures are aligned -- and what
  // makes an oversized one grow upward into the screen rather than sink.
  const place = (src, slot) => {
    if (!src) { ghost(slot); return; }
    // A record's own scale overrides the slot's default (BATTLE_SCALE_DEFAULT)
    // exactly like BattleState.resolveBattleScale does -- an explicit
    // battle_sprite_scales entry beats the fallback.
    const eff = src.scale != null ? src.scale : slot.scale;
    const w = src.w * eff, h = src.h * eff;
    c.drawImage(baked(src), Math.round(slot.x + (slot.w - w) / 2), Math.round(slot.y + slot.h - h), w, h);
  };

  const name = (o.name || "trainer").slice(0, 10);

  function redraw() {
    c.imageSmoothingEnabled = false;
    c.fillStyle = rgbOf(DMG[0]);
    c.fillRect(0, 0, GB_W, GB_H);

    box(4, 14, 84, 26);
    say(name, 8, 24);
    hpbar(8, 30, 60);

    box(74, 58, 82, 30);
    say("you", 78, 68);
    hpbar(78, 74, 60);

    box(0, 96, GB_W, 48);

    // Clipped to the screen, because that is the honest part: whatever spills
    // off the edge is what the player would never see.
    c.save();
    c.beginPath();
    c.rect(0, 0, GB_W, GB_H);
    c.clip();
    place(front, BATTLE_ENEMY);
    place(back, BATTLE_PLAYER);
    c.restore();

    // Drawn last so an oversized picture goes behind the words rather than
    // hiding that the text box is where it is.
    box(0, 96, GB_W, 48);
    say(name + " wants to fight!", 8, 112);

    const out = cv.getContext("2d");
    out.imageSmoothingEnabled = false;
    out.clearRect(0, 0, cv.width, cv.height);
    out.drawImage(off, 0, 0, cv.width, cv.height);
  }

  redraw();
  for (const src of [front, back]) {
    if (src && !src.live && !(src.img.complete && src.img.naturalWidth)) {
      src.img.addEventListener("load", redraw, { once: true });
    }
  }
  return cv;
}

/* The palette the mock is showing, kept out here on purpose: the studio and
   the NPC form both draw one, and having picked BROWNMON in one of them you
   want it still picked in the other. */
const battleView = { pal: BATTLE_PAL_DEFAULT };

/**
 * The mock, with the Palette picker that drives it.
 *
 * Everything the caller passes goes straight through to battleMock; the panel
 * only owns which named palette it is drawn under, and redraws itself in
 * place when that changes.
 */
function battleMockPanel(o) {
  const host = el("div", {});
  const controls = el("div", {});
  const wrap = el("div", { class: "battlewrap" });
  host.append(controls, wrap);

  function draw() {
    const pack = GAME?.palettes?.palettes;
    // "As imported" art skips the bake entirely (see battleMock), so the
    // picker only means something when at least one visible picture is set
    // to "Colour palette". Nothing present at all falls through to shown --
    // there is no picture either way, so it does not matter.
    const sources = [o.facing, o.back].filter(Boolean);
    const showPicker = sources.length === 0 || sources.some((a) => !a.trueColor);

    controls.textContent = "";
    if (showPicker) {
      // Black and white first -- it needs no game data and is the plainest
      // choice -- then the ten species palettes the loaded pack actually has.
      const names = [BW_PAL, ...MON_PAL_ORDER.filter((n) => pack?.[n])];
      // A name the pack does not have falls back to MEWMON in the mock, so
      // move the picker with it rather than leaving the two disagreeing.
      if (battleView.pal !== BW_PAL && !pack?.[battleView.pal]) battleView.pal = BATTLE_PAL_DEFAULT;
      const label = (n) => (n === BW_PAL ? "Black and white" : n);
      const sel = el("select", { onchange: () => { battleView.pal = sel.value; draw(); } },
        names.map((n) => el("option", { value: n, selected: n === battleView.pal }, label(n))));
      controls.append(el("div", { class: "palpick" },
        el("span", {}, "Palette"), sel));
    }

    wrap.textContent = "";
    wrap.append(battleMock({ ...o, pal: palColours(battleView.pal) }));
  }

  draw();
  return host;
}

// What the game's own use, purely so the mock can say whether this one is
// the usual size or not. Not a rule -- the engine takes any size.
const BATTLE_USUAL = { facing: 56, back: 32 };

/* ------------------------------------------------------------ the studio -- */

/**
 * The import dialog for a sheet of frames.
 *
 * `mode` is "strip" for an overworld sheet -- find shapes, say which is which
 * pose, pack -- "single" for a facing/back picture, which is one image and
 * wants cropping rather than cutting -- or "icon" for a two-frame menu icon,
 * which shares the strip machinery but with its own two-slot shape instead of
 * the six walking poses.
 */
function spriteStudio(o) {
  const mode = o.mode || "strip";
  const S = {
    cv: null, srcCv: null, preColour: null, w: 0, h: 0,
    boxes: [], roles: [], roleAt: 0, ignored: [],
    // filmstrip only: which detected shapes are actually frames, in the
    // order they were tapped. Nothing is picked for you -- see the load
    // branch below for why.
    picked: [],
    specify: false, grey: false, zoom: 2, drag: null, packed: null,
    // BattleState.BATTLE_SCALE_DEFAULT -- what facing/back get with nothing
    // overriding it. Only meaningful for mode === "single" && o.battle;
    // BATTLE_SCALE_DEFAULT[o.battle] set on file load.
    scale: 1,
  };

  const body = el("div", {});
  const fileRow = el("div", {});
  const work = el("div", { style: "display:none" });
  body.append(fileRow, work);

  /* --- the file -------------------------------------------------------- */

  const input = el("input", { type: "file", accept: "image/png,image/*" });
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
    S.srcCv = canvasOf(img);
    S.cv = canvasOf(img);
    S.w = S.cv.width; S.h = S.cv.height;
    S.zoom = S.w > 400 ? 1 : S.w > 200 ? 2 : 3;
    S.grey = false; S.preColour = null;
    S.scale = BATTLE_SCALE_DEFAULT[o.battle] || 1;
    const knocked = autoKnockBackground(S.cv);
    if (mode === "filmstrip") {
      // A strip exported from here carries its own grid, drawn as guide
      // lines -- read those and the cells come back exactly as they went
      // out, which is what makes the export/paint/import round trip clean.
      // Anything else falls back to island detection, which finds shapes
      // rather than frames: a title, a stray fleck, or one frame drawn in
      // two separate pieces all come back as islands too.
      const guided = guideGridBoxes(pixels(), S.w, S.h);
      S.guided = !!guided;
      if (guided) {
        S.boxes = guided;
        // The guides have done their job; they are not art, so they go
        // before anything is cropped out of the sheet.
        knockOutColour(S.cv, GUIDE_RGB[0], GUIDE_RGB[1], GUIDE_RGB[2], 40);
      } else {
        S.boxes = sortBoxes(framesByIslands(pixels(), S.w, S.h));
      }
      // Nothing is picked for you either way: tapping builds the play
      // order, so the order is yours rather than whatever the sheet's
      // layout happened to imply.
      S.picked = [];
    } else {
      S.roles = new Array(mode === "single" ? 1 : mode === "icon" ? 2 : 6).fill(null);
      S.ignored = new Array(S.roles.length).fill(false);
      if (mode === "single") S.boxes = [{ x: 0, y: 0, w: S.w, h: S.h }];
      else redetect();
    }
    work.style.display = "";
    drawAll();
    if (knocked) toast("Removed the flat background colour");
  };
  fileRow.append(el("p", { class: "hint" }, o.hint), input);

  /* --- the source sheet, with the cut drawn over it --------------------- */

  const sheetTools = el("div", {});

  /**
   * Trim a box to the art inside it, taking its background with it.
   *
   * The one operation "specify sprite" is: knock out the box's own flat
   * background if it still has one, then hand what is left to the finder and
   * keep the bounds it comes back with. Both modes want exactly this -- a
   * sheet wants it per sprite, a single picture wants it once -- so both call
   * it rather than keeping two copies that can drift apart.
   */
  function tightened(b) {
    const knocked = autoKnockBoxBackground(S.cv, b);
    const tight = shapeInRegion(pixels(), S.w, S.h, b);
    if (!tight) { toast("Nothing but empty space in that box", true); return null; }
    if (knocked) toast("Removed the background colour from that box");
    return tight;
  }

  function drawTools() {
    sheetTools.textContent = "";
    sheetTools.append(el("label", {},
      el("input", {
        type: "checkbox", checked: S.specify,
        onchange: (e) => {
          S.specify = e.target.checked;
          if (!S.specify) { drawAll(); return; }
          if (mode === "single") {
            // One picture has a crop already -- the whole image, or whatever
            // was dragged before ticking -- so ticking does the work to it
            // straight away instead of waiting to be asked again.
            const tight = tightened(S.boxes[0] || { x: 0, y: 0, w: S.w, h: S.h });
            if (tight) S.boxes = [tight];
          } else {
            // Automatic detection is exactly what somebody is opting out of
            // by ticking this -- so its shapes (often over- or
            // under-clustered, which is the whole reason to reach for this)
            // are cleared rather than left sitting in the tray next to the
            // ones drawn by hand. fillRoles() with an empty S.boxes does the
            // reset the same way a fresh sheet does: every role slot null,
            // cursor on the first one still asking.
            S.boxes = [];
            if (mode === "filmstrip") S.picked = []; else fillRoles();
          }
          drawAll();
        },
      }),
      mode === "single" ? "Specify sprite — cut it out myself" : "Specify sprite — box them by hand"));
    sheetTools.append(el("p", { class: "hint" }, mode === "single"
      ? (S.specify
        ? "Drag a box round the picture. Its flat background is knocked out and the crop is pulled in "
          + "tight to the art itself, so what ships is the drawing and not the paper it was on."
        : "The crop is whatever box you drag, background and all. Tick this and the box is cleaned up "
          + "instead — background removed, edges pulled in to the art.")
      : (S.specify
        ? "Drag a box round one sprite. What is inside it is trimmed to its own edges the same way the "
          + "automatic pass does it, its own flat background knocked out if it still has one, and added "
          + "to the shapes below — so a sheet the finder got wrong can be cut by hand, one sprite at a "
          + "time. Tap a box to drop it again."
        : "Shapes were found automatically. If they came back wrong — one box round everything, or a "
          + "hundred specks — tick this and box the sprites yourself.")));
  }

  const zoomRow = el("div", { class: "zoomrow" });

  function setZoom(z) {
    S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    drawSheet();
    drawZoom();
  }

  function drawZoom() {
    zoomRow.textContent = "";
    zoomRow.append(
      el("button", {
        class: "fixed", title: "Zoom out", disabled: S.zoom <= ZOOM_MIN,
        onclick: () => setZoom(S.zoom - 1),
      }, "🔍−"),
      el("span", { class: "zoomlabel" }, S.zoom + "×"),
      el("button", {
        class: "fixed", title: "Zoom in", disabled: S.zoom >= ZOOM_MAX,
        onclick: () => setZoom(S.zoom + 1),
      }, "🔍+"));
  }

  const scroller = el("div", { class: "sheetwrap" });
  const view = el("canvas", { class: "sheetview" });
  scroller.append(view);

  function drawSheet() {
    const z = S.zoom;
    view.width = S.w * z; view.height = S.h * z;
    view.style.width = (S.w * z) + "px";
    view.style.height = (S.h * z) + "px";
    const c = view.getContext("2d");
    c.imageSmoothingEnabled = false;
    // A checkerboard, so "transparent" is visibly different from "white" --
    // which is exactly the distinction the background removal is about.
    c.fillStyle = "#2b3440";
    c.fillRect(0, 0, view.width, view.height);
    c.fillStyle = "#38424e";
    for (let y = 0; y < view.height; y += 8) {
      for (let x = 0; x < view.width; x += 8) {
        if (((x / 8) + (y / 8)) % 2 === 0) c.fillRect(x, y, 8, 8);
      }
    }
    c.drawImage(S.cv, 0, 0, S.w * z, S.h * z);

    S.boxes.forEach((b, i) => {
      const used = S.roles.indexOf(i);
      c.lineWidth = 1;
      c.strokeStyle = used >= 0 ? "#c85048" : "#70b8f0";
      c.strokeRect(b.x * z + 0.5, b.y * z + 0.5, b.w * z - 1, b.h * z - 1);
      if (used >= 0) {
        c.fillStyle = "#c85048";
        c.fillRect(b.x * z, b.y * z, 12, 10);
        c.fillStyle = "#f0f0f8";
        c.font = "9px monospace";
        c.fillText(String(used + 1), b.x * z + 3, b.y * z + 8);
      }
    });
  }

  const atPixel = (ev) => {
    const r = view.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(S.w - 1, Math.floor((ev.clientX - r.left) / S.zoom))),
      y: Math.max(0, Math.min(S.h - 1, Math.floor((ev.clientY - r.top) / S.zoom))),
    };
  };

  view.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const p = atPixel(ev);
    // Tapping a shape drops it, dragging adds one. Which of the two it was is
    // not known until the pointer comes back up, so the box under it is only
    // remembered here -- dropping it on the way down would make it impossible
    // to draw a box across one, and drawing across a wrong box is exactly
    // what "specify sprite" is for. A single picture has exactly one box and
    // it is a crop, so there the drag re-crops and a tap does nothing --
    // tap-to-remove would leave the slot empty with no way back.
    const hit = mode === "single" ? -1
      : S.boxes.findIndex((b) => p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h);
    S.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, hit };
    view.setPointerCapture(ev.pointerId);
  });

  view.addEventListener("pointermove", (ev) => {
    if (!S.drag) return;
    const p = atPixel(ev);
    S.drag.x1 = p.x; S.drag.y1 = p.y;
    drawSheet();
    const c = view.getContext("2d"), z = S.zoom;
    const b = dragBox();
    c.strokeStyle = "#e08a2e";
    c.strokeRect(b.x * z + 0.5, b.y * z + 0.5, b.w * z - 1, b.h * z - 1);
  });

  const endDrag = () => {
    if (!S.drag) return;
    const b = dragBox();
    // A couple of pixels of travel is a tap somebody made on a phone, not a
    // box: a real one is never three pixels square.
    const tap = b.w <= 3 && b.h <= 3;
    const hit = S.drag.hit;
    S.drag = null;
    if (mode === "single") {
      if (!tap) {
        const box = S.specify ? tightened(b) : b;
        if (box) S.boxes = [box];
      }
    }
    // Tapping a detected box means "use this one" on a filmstrip, where the
    // tray is opt-in; everywhere else the tray is the assignment surface and
    // a tap on the sheet is how a wrong detection gets thrown away.
    else if (tap) {
      if (hit >= 0) { if (mode === "filmstrip") pickFrame(hit); else removeBox(hit); }
    }
    else if (S.specify) {
      const tight = tightened(b);
      if (tight) addBox(tight);
    } else addBox(b);
    drawAll();
  };
  view.addEventListener("pointerup", endDrag);
  view.addEventListener("pointercancel", endDrag);

  function dragBox() {
    const d = S.drag;
    return {
      x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
      w: Math.abs(d.x1 - d.x0) + 1, h: Math.abs(d.y1 - d.y0) + 1,
    };
  }

  /* --- finding and assigning ------------------------------------------- */

  function pixels() {
    return S.cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, S.w, S.h);
  }

  function redetect() {
    S.boxes = sortBoxes(framesByIslands(pixels(), S.w, S.h));
    fillRoles();
  }

  const firstFree = () => S.roles.findIndex((r, i) => r === null && !S.ignored[i]);

  // Reading order is right often enough to be what happens rather than
  // something the user has to ask for; the slots are there to correct it.
  // Poses ticked off as missing are skipped, so the shapes land in the slots
  // that are still asking for one.
  function fillRoles() {
    let k = 0;
    S.roles = S.roles.map((_, i) => (S.ignored[i] || k >= S.boxes.length ? null : k++));
    const empty = firstFree();
    S.roleAt = empty < 0 ? 0 : empty;
  }

  // A shape added by hand goes into the first slot still asking for one,
  // rather than re-filling every slot from scratch: by the time somebody is
  // boxing sprites themselves, the assignments they already made are work.
  // A filmstrip has no slots to fill -- a hand-drawn box is just one more
  // frame, appended to the end of the play order.
  function addBox(b) {
    S.boxes.push(b);
    // A box drawn by hand on a filmstrip is unambiguously wanted -- nobody
    // drags a rectangle they did not mean -- so unlike detection it goes
    // straight into the play order.
    if (mode === "filmstrip") { S.picked.push(S.boxes.length - 1); return; }
    const slot = firstFree();
    if (slot >= 0) {
      S.roles[slot] = S.boxes.length - 1;
      const empty = firstFree();
      S.roleAt = empty < 0 ? slot : empty;
    }
  }

  function removeBox(hit) {
    S.boxes.splice(hit, 1);
    if (mode === "filmstrip") {
      // every use of the deleted shape goes with it; the rest shuffle down
      S.picked = S.picked.filter((p) => p !== hit).map((p) => (p > hit ? p - 1 : p));
      return;
    }
    S.roles = S.roles.map((r) => (r === hit ? null : r > hit ? r - 1 : r));
  }

  const roleRow = el("div", {});

  function frameCanvas(b, scale) {
    const cv = el("canvas", { width: b.w * scale, height: b.h * scale });
    const c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(S.cv, b.x, b.y, b.w, b.h, 0, 0, b.w * scale, b.h * scale);
    return cv;
  }

  // Tapping a shape always APPENDS it, so the same one can be used twice --
  // a hold, or a there-and-back cycle, is a normal thing to want out of a
  // handful of frames. Removal is the × on the play-order entry itself,
  // which is unambiguous about which of the two it is taking out.
  const pickFrame = (i) => { S.picked.push(i); };

  /**
   * A filmstrip's frames: what was found, and what the user picked out of it.
   *
   * Nothing starts picked. Detection returns shapes, not frames -- a title
   * on the sheet, a stray fleck, or one frame drawn as two separate pieces
   * all come back as islands -- so "everything, minus the mistakes" makes
   * you hunt for the mistakes. Tapping to build the list also makes the
   * ORDER yours: play order is the order you tapped, not reading order.
   */
  function drawFilmstripFrames() {
    roleRow.textContent = "";
    roleRow.append(el("h2", {}, "Frames, in play order"));

    if (!S.picked.length) {
      roleRow.append(el("p", { class: "hint warn" },
        "Nothing picked yet — tap the shapes below in the order they should play."));
    } else {
      const strip = el("div", { class: "spritegrid" });
      S.picked.forEach((boxI, n) => {
        const b = S.boxes[boxI];
        if (!b) return;
        strip.append(el("div", { class: "spritepick sel" },
          frameCanvas(b, 2),
          el("span", {}, "frame " + (n + 1)),
          el("div", { class: "row", style: "margin-top:4px" },
            el("button", {
              class: "fixed", disabled: n === 0,
              onclick: () => { S.picked.splice(n - 1, 0, ...S.picked.splice(n, 1)); drawAll(); },
            }, "↑"),
            el("button", {
              class: "fixed", disabled: n === S.picked.length - 1,
              onclick: () => { S.picked.splice(n + 1, 0, ...S.picked.splice(n, 1)); drawAll(); },
            }, "↓"),
            el("button", { class: "fixed danger", onclick: () => { S.picked.splice(n, 1); drawAll(); } }, "×"))));
      });
      roleRow.append(strip);
    }

    roleRow.append(el("h2", { style: "margin-top:10px" },
      S.guided ? "Cells on the sheet — tap to add" : "Shapes found — tap to add"));
    // With a guided grid every cell IS a frame and they are already in
    // order, so the common case is "all of them" and should cost one tap
    // rather than twenty-one. Still not automatic: picking stays the
    // user's, this is just the shortcut for the obvious answer.
    roleRow.append(el("div", { class: "row", style: "margin-bottom:6px;flex-wrap:wrap" },
      el("button", {
        class: "fixed",
        onclick: () => { S.boxes.forEach((_, i) => S.picked.push(i)); drawAll(); },
      }, "Add all, in order"),
      S.picked.length
        ? el("button", { class: "fixed danger", onclick: () => { S.picked = []; drawAll(); } }, "Clear")
        : null));
    const tray = el("div", { class: "spritegrid" });
    S.boxes.forEach((b, i) => {
      const uses = S.picked.filter((p) => p === i).length;
      tray.append(el("button", {
        class: "spritepick" + (uses ? " sel" : ""),
        onclick: () => { pickFrame(i); drawAll(); },
      },
        frameCanvas(b, 2),
        el("span", {}, uses ? `used ${uses}x` : `${b.w}x${b.h}`)));
    });
    roleRow.append(tray);
    roleRow.append(el("p", { class: "hint" },
      (S.guided
        ? `${S.boxes.length} cells, read straight off the guide lines this sheet was exported with — `
          + "they come back exactly as they went out. "
        : `${S.boxes.length} shape(s) found by looking for islands of pixels, since this sheet has no `
          + "guide lines. One frame drawn in two separate pieces comes back as two, so check the cells "
          + "against what you painted. ")
      + "Tap one to add it to the end of the play order — the same twice is fine, and is how a hold or "
      + "a there-and-back cycle is made. The × above takes one back out. Tapping a box on the sheet "
      + "adds it too, and dragging adds one that was missed."));
  }

  function drawRoles() {
    roleRow.textContent = "";
    if (mode === "single") return;
    if (mode === "filmstrip") { drawFilmstripFrames(); return; }
    roleRow.append(el("h2", {}, mode === "icon" ? "Which shape is which frame" : "Which shape is which pose"));

    const names = mode === "icon" ? ["frame 1", "frame 2"] : frameNames();
    const slots = el("div", { class: "roleslots" });
    S.roles.forEach((boxI, i) => {
      const off = !!S.ignored[i];
      const cell = el("button", {
        class: "roleslot" + (S.roleAt === i ? " at" : "") + (boxI === null ? " empty" : "")
          + (off ? " off" : ""),
        onclick: () => {
          if (off) S.ignored[i] = false;
          else if (boxI !== null) S.roles[i] = null;
          S.roleAt = i;
          drawAll();
        },
      });
      cell.append(boxI !== null && S.boxes[boxI]
        ? frameCanvas(S.boxes[boxI], 2)
        : el("div", { class: "none" }, off ? "skipped" : "—"));
      cell.append(el("span", {}, names[i] || "frame " + (i + 1)));
      slots.append(cell);
    });
    roleRow.append(slots);
    roleRow.append(skipRow);

    roleRow.append(el("p", { class: "hint" }, mode === "icon"
      ? `${S.boxes.length} shape(s) found. Tap a slot, then tap one below to put it there — or tap a box on `
        + "the sheet to drop it and drag to add one. Leave the second frame empty for an icon that does not "
        + "animate."
      : `${S.boxes.length} shape(s) found. Tap a slot, then tap one below to put it there — or tap a box on `
        + "the sheet to drop it and drag to add one. Facing right is drawn by mirroring left, so it is never "
        + "a frame of its own. Leave the walking three empty for someone who stands still, and exclude "
        + "anything this sheet simply has not got."));

    const tray = el("div", { class: "spritegrid" });
    S.boxes.forEach((b, i) => {
      tray.append(el("button", {
        class: "spritepick" + (S.roles.includes(i) ? " sel" : ""),
        onclick: () => {
          S.roles[S.roleAt] = i;
          const empty = firstFree();
          S.roleAt = empty >= 0 ? empty : Math.min(S.roleAt + 1, S.roles.length - 1);
          drawAll();
        },
      }, frameCanvas(b, 2), el("span", {}, `${b.w}x${b.h}`)));
    });
    if (!S.boxes.length) tray.append(el("div", { class: "empty" }, "Nothing found — drag a box on the sheet."));
    roleRow.append(tray);
  }

  /* --- poses the sheet has not got --------------------------------------- */

  /**
   * Which slots to stop asking about.
   *
   * A sheet missing a pose used to leave two bad choices: put a picture that
   * faces the wrong way in the slot, or drop to a shorter shape and silently
   * lose every frame after it. Ticking the pose off is the third one -- the
   * slot stops asking, the shape stays as long as it was, and what goes in
   * that position is a stand-in this code picks and says out loud, rather
   * than a wrong sprite the user had to choose themselves.
   */
  const skipRow = el("div", {});

  function drawSkips() {
    skipRow.textContent = "";
    if (mode === "single" || !S.roles.length) return;
    skipRow.append(el("h2", {}, "Exclude sprite"));
    skipRow.append(el("p", { class: "hint" }, mode === "icon"
      ? "Tick the second frame off for an icon that does not animate — the first frame ships alone in "
        + "its place."
      : "Tick anything there is no art for and its slot stops asking for one. The engine still reads the "
        + "strip by position, so something has to sit there: a ticked walking frame reuses its own standing "
        + "pose, and a ticked direction reuses “down”. What ships says which ones those were."));
    const names = mode === "icon" ? ["frame 1", "frame 2"] : frameNames();
    const grid = el("div", { class: "skipgrid" });
    S.roles.forEach((_, i) => {
      grid.append(el("label", {},
        el("input", {
          type: "checkbox", checked: !!S.ignored[i],
          onchange: (e) => {
            S.ignored[i] = e.target.checked;
            if (e.target.checked && S.roles[i] !== null) S.roles[i] = null;
            const empty = firstFree();
            if (empty >= 0) S.roleAt = empty;
            drawAll();
          },
        }),
        names[i] || "frame " + (i + 1)));
    });
    skipRow.append(grid);
  }

  /* --- colour ----------------------------------------------------------- */

  function copyCanvas(src) {
    const cv = el("canvas", { width: src.width, height: src.height });
    const c = cv.getContext("2d", { willReadFrequently: true });
    c.imageSmoothingEnabled = false;
    c.drawImage(src, 0, 0);
    return cv;
  }

  const colourRow = el("div", {});

  function drawColour() {
    colourRow.textContent = "";
    colourRow.append(el("h2", {}, "Colour"));
    colourRow.append(el("div", { class: "tools" },
      el("button", { class: !S.grey ? "on" : "", onclick: () => {
        if (!S.grey) return;
        if (S.preColour) S.cv = S.preColour;
        S.preColour = null; S.grey = false;
        drawAll();
      } }, "As imported"),
      el("button", { class: S.grey ? "on" : "", onclick: () => {
        if (S.grey) return;
        S.preColour = copyCanvas(S.cv);
        toGreyscale(S.cv); S.grey = true; drawAll();
      } }, "Colour palette")));
    colourRow.append(el("p", { class: "hint" }, S.grey
      ? "Flattened to shades of grey with no colour of its own, so the engine puts it through its own "
        + "palette the way it does the game's sprites." + (mode === "single" && o.battle
          ? " Pick which one below." : "")
      : "Shipped exactly as imported (trueColor), so it looks like it did in your art program."));
  }

  /* --- the result ------------------------------------------------------- */

  const outRow = el("div", {});

  // What stands in for a pose that was ticked off. A walking frame borrows
  // its own standing one, which reads as somebody who does not bob rather
  // than as a mistake; anything else borrows "down", and a sheet with no
  // "down" borrows whatever it does have.
  function standIn(i) {
    const chain = i >= 3 ? [i - 3, 0] : i > 0 ? [0] : [];
    for (const j of chain) if (S.roles[j] !== null) return S.roles[j];
    const any = S.roles.find((r) => r !== null);
    return any === undefined ? null : any;
  }

  function chosen() {
    if (mode === "single") return S.boxes.length ? { boxes: S.boxes.slice(0, 1), pose: "" } : null;
    if (mode === "filmstrip") {
      const boxes = S.picked.map((i) => S.boxes[i]).filter(Boolean);
      return boxes.length ? { boxes, pose: "", stood: [] } : null;
    }
    for (const [n, pose] of (mode === "icon" ? ICON_SHAPES : POSE_SHAPES)) {
      if (S.roles.length < n) continue;
      const slots = Array.from({ length: n }, (_, i) => i);
      // Ticked-off slots count as answered, so a missing "up" no longer drops
      // a six-frame sheet back to one frame.
      if (!slots.every((i) => S.roles[i] !== null || S.ignored[i])) continue;
      if (!slots.some((i) => S.roles[i] !== null)) continue;
      const stood = [];
      const boxes = slots.map((i) => {
        if (S.roles[i] !== null) return S.boxes[S.roles[i]];
        stood.push(i);
        const j = standIn(i);
        return j === null ? null : S.boxes[j];
      });
      if (boxes.some((b) => !b)) continue;
      return { boxes, pose, stood };
    }
    return null;
  }

  function drawOut() {
    outRow.textContent = "";
    outRow.append(el("h2", {}, "What ships"));
    const pick = chosen();
    if (!pick) {
      outRow.append(el("p", { class: "hint warn" }, mode === "single"
        ? "Drag a box on the sheet to choose the part to keep."
        : mode === "icon"
        ? "Fill in “frame 1” at least — add “frame 2” for it to animate, or tick it off for a still icon."
        : mode === "filmstrip"
        ? "Nothing left to play — un-exclude a frame above, or drag a box on the sheet to add one."
        : "Fill in “down” at least — then “up” and “left” for someone who turns, "
          + "and all six to walk. A pose this sheet has not got can be ticked off instead of filled."));
      ok.disabled = true;
      S.packed = null;
      return;
    }
    ok.disabled = false;

    const packed = mode === "single"
      ? (() => {
          const b = pick.boxes[0];
          const cv = frameCanvas(b, 1);
          return { cv, png: pngOf(cv), w: b.w, h: b.h, frameW: b.w, frameH: b.h, frames: 1 };
        })()
      : packStrip(S.cv, pick.boxes);
    S.packed = packed;

    const shot = el("canvas", { width: packed.w * 2, height: packed.h * 2 });
    const sc = shot.getContext("2d");
    sc.imageSmoothingEnabled = false;
    sc.drawImage(packed.cv, 0, 0, packed.w * 2, packed.h * 2);
    outRow.append(el("div", { class: "sheetwrap", style: "max-height:200px" }, shot));
    outRow.append(el("p", { class: "hint" }, mode === "single"
      ? `${packed.w} x ${packed.h}, shipped as one picture.`
      : mode === "icon"
      ? `${packed.frames} frame${packed.frames === 1 ? "" : "s"} of ${packed.frameW} x ${packed.frameH}, `
        + `packed into a ${packed.w} x ${packed.h} strip — the shape the party and Pokedex lists animate.`
      : mode === "filmstrip"
      ? `${packed.frames} frame${packed.frames === 1 ? "" : "s"} of ${packed.frameW} x ${packed.frameH}, `
        + `packed into a ${packed.w} x ${packed.h} strip. Plays 1 through ${packed.frames}, in order, once.`
      : `${packed.frames} frame${packed.frames === 1 ? "" : "s"} of ${packed.frameW} x ${packed.frameH} `
        + `(${pick.pose}), packed into a `
        + `${packed.w} x ${packed.h} strip — the shape the engine reads. Anchored at `
        + `${packed.frameW / 2}, ${packed.frameH} (centred, standing on the tile).`));
    if (pick.stood?.length) {
      const names = mode === "icon" ? ["frame 1", "frame 2"] : frameNames();
      outRow.append(el("p", { class: "hint warn" },
        "Ticked off as missing, so a stand-in sits in that position: "
        + pick.stood.map((i) => names[i] || "frame " + (i + 1)).join(", ") + "."));
    }
  }

  /* --- in a battle ------------------------------------------------------ */

  /**
   * The same picture, on the screen it will actually be on.
   *
   * Only for the single-picture slots, and only because those are the two
   * where nothing else in this dialog gives any sense of scale: an overworld
   * strip has the walk preview next to it on the form, but a facing sprite is
   * just a picture in a box until you see it next to a text box.
   */
  const battleRow = el("div", {});

  function drawBattle() {
    battleRow.textContent = "";
    if (mode !== "single" || !o.battle || !S.packed) return;
    battleRow.append(el("h2", {}, "In a battle"));
    // Tracks the Colour buttons above, so this preview follows the same
    // choice the export will actually ship: "As imported" -> shown untouched;
    // "Colour palette" -> the Palette picker below decides how it is baked.
    // scale tracks the Scale field below, the same way.
    const art = { cv: S.packed.cv, trueColor: !S.grey, scale: S.scale };
    battleRow.append(battleMockPanel({
      facing: o.battle === "facing" ? art : null,
      back: o.battle === "back" ? art : null,
      name: o.who,
      scale: 2,
    }));

    // How big this picture is drawn, just under the preview it changes --
    // BattleState.resolveBattleScale's own fallback (facing 1x, back 2x)
    // unless a battle_sprite_scales entry overrides it, which is exactly
    // what this field becomes on export.
    const def = BATTLE_SCALE_DEFAULT[o.battle] || 1;
    battleRow.append(el("div", { class: "row", style: "align-items:center;margin-top:6px" },
      el("span", { class: "fixed", style: "min-width:50px;color:var(--dim);font-size:14px" }, "Scale"),
      el("input", { type: "number", min: "0.25", max: "4", step: "0.25", value: String(S.scale),
        oninput: (e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v > 0) { S.scale = Math.min(4, Math.max(0.25, v)); drawBattle(); }
        } }),
      el("button", { class: "fixed", disabled: S.scale === def, onclick: () => { S.scale = def; drawBattle(); } },
        `Reset (${def}x)`)));
    battleRow.append(el("p", { class: "hint" },
      o.battle === "back"
        ? `Back sprites are drawn at ${def}x their size unless something overrides it, which is why the `
          + "game's own look soft — this preview does the same, and ships as a battle_sprite_scales entry "
          + "alongside the picture if you change it."
        : `Facing sprites are drawn at ${def}x (their own size) unless something overrides it. Change this if `
          + "yours should sit bigger or smaller than the trainer it belongs to."));

    const usual = BATTLE_USUAL[o.battle] || 56;
    const big = S.packed.w > usual * 1.35 || S.packed.h > usual * 1.35;
    battleRow.append(el("p", { class: "hint" + (big ? " warn" : "") },
      `Yours is ${S.packed.w} x ${S.packed.h}; the game's own are about ${usual} px.`
      + (big ? " Yours is a good deal bigger than that, so it takes up more of the screen than anything "
        + "the game does — fine if you meant it." : "")));
  }

  /* --- assembly --------------------------------------------------------- */

  function drawAll() {
    drawTools();
    drawZoom();
    drawSheet();
    drawRoles();
    drawSkips();
    drawColour();
    drawOut();
    drawBattle();
  }

  const ok = el("button", { class: "primary", disabled: true, onclick: () => {
    const packed = S.packed;
    if (!packed) return;
    closeDialog();
    o.onDone(mode === "single"
      ? { png: packed.png, w: packed.w, h: packed.h, trueColor: !S.grey, scale: S.scale }
      : mode === "icon" || mode === "filmstrip"
      ? {
          png: packed.png, w: packed.w, h: packed.h,
          frameW: packed.frameW, frameH: packed.frameH, frames: packed.frames,
          trueColor: !S.grey,
        }
      : {
          png: packed.png, w: packed.w, h: packed.h,
          frameW: packed.frameW, frameH: packed.frameH, frames: packed.frames,
          walker: packed.frames >= 6,
          anchorX: packed.frameW / 2, anchorY: packed.frameH,
          trueColor: !S.grey,
        });
  } }, "Use this");

  work.append(sheetTools, zoomRow, scroller, roleRow, colourRow, outRow, battleRow,
    el("div", { class: "row", style: "margin-top:12px" },
      ok, el("button", { class: "fixed", onclick: closeDialog }, "Cancel")));

  dialog(o.title, body);
}
