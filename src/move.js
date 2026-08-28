"use strict";
/* ============================================================================
   Oak's Lab — the Moves workspace.

   Same shape as the Pokemon screen: one scrolling column of numbered steps
   you can come back to in any order. A move IS a plain `moves` content
   record, so it lives in P.entries like everything else and the Content/All
   records tab keeps seeing it.

   Three parts of this are more than a form, and each is here because the
   engine's own data made the honest answer awkward:

     - the STATUS CHANCE (step 4). Gen 1 has no "10% chance to burn" field.
       It has sixty-eight named effects, four of which happen to burn things,
       and the odds are baked into each one. So this step asks the question a
       person actually has -- which condition, how often -- and either finds
       the vanilla effect that already means that, or writes a small Lua
       function that does. Which one it did is shown, not hidden.

     - the ANIMATION (step 5) is four tables deep and none of them is a
       picture on its own, so borrowing one of the game's is PLAYED here
       rather than named. Painting your own sidesteps those tables entirely
       -- a plain strip of frames, played back on the battle.move_used /
       battle.overlay hooks -- which is also why "export the game's art" can
       hand back a paintable picture instead of the raw tile sheet.

   The overworld (Cut, Surf and friends) is deliberately NOT a step here: Gen
   1 checks for them by move id in hard-coded overworld code, there is no
   field for it and no hook this tool can wire up, and a step whose whole
   content is "no, but you can patch an existing one over" was worse than no
   step. Patching a vanilla move -- for that or any other reason -- is still
   possible from the Content/All records tab, same as any other record.
   ========================================================================== */

/* ------------------------------------------------------------- the record -- */

/**
 * Which types hit off Attack and which off Special.
 *
 * Gen 1 has no per-move physical/special split: the TYPE decides, and the
 * cut runs between GHOST and FIRE in the ROM's type order. From the engine's
 * own TypeChart.TYPES, which is a Lua table rather than generated data, so
 * this is the one thing here that is copied rather than read.
 */
const MOVE_TYPE_CATEGORY = {
  NORMAL: "physical", FIGHTING: "physical", FLYING: "physical", POISON: "physical",
  GROUND: "physical", ROCK: "physical", BUG: "physical", GHOST: "physical",
  FIRE: "special", WATER: "special", GRASS: "special", ELECTRIC: "special",
  PSYCHIC_TYPE: "special", ICE: "special", DRAGON: "special",
};

// The five conditions a Pokemon can carry, plus the two turn-scoped things
// Gen 1 treats the same way in a move's effect but does not store on the mon.
const MOVE_STATUSES = [
  { id: "SLP", label: "Asleep", note: "Cannot move for 1-7 turns." },
  { id: "PSN", label: "Poisoned", note: "Loses HP every turn, in battle and on the map." },
  { id: "PAR", label: "Paralysed", note: "Quarter speed, and a quarter of turns are lost." },
  { id: "BRN", label: "Burned", note: "Loses HP every turn and hits half as hard physically." },
  { id: "FRZ", label: "Frozen", note: "Cannot move at all until a Fire move thaws it. Brutal." },
  { id: "CONFUSION", label: "Confused", note: "For 2-5 turns, may hit itself instead.", notReal: true },
  { id: "FLINCH", label: "Flinching", note: "Loses this turn only, and only if it had not moved yet.", notReal: true },
];
const statusRow = (id) => MOVE_STATUSES.find((s) => s.id === id) || null;

/**
 * The effects the game already has for "a chance of X", as chance-out-of-256.
 *
 * These are the numbers inside the engine's own statusSide()/flinchSide()
 * calls. Matching one exactly means the mod ships no Lua at all -- it just
 * names the effect THUNDERBOLT already uses -- which is a much better first
 * mod than one carrying a function nobody asked for.
 */
const VANILLA_SIDE_EFFECTS = {
  BRN: [[26, "BURN_SIDE_EFFECT1"], [77, "BURN_SIDE_EFFECT2"]],
  FRZ: [[26, "FREEZE_SIDE_EFFECT1"]],
  PAR: [[26, "PARALYZE_SIDE_EFFECT1"], [77, "PARALYZE_SIDE_EFFECT2"]],
  PSN: [[52, "POISON_SIDE_EFFECT1"], [103, "POISON_SIDE_EFFECT2"]],
  FLINCH: [[26, "FLINCH_SIDE_EFFECT1"], [77, "FLINCH_SIDE_EFFECT2"]],
  CONFUSION: [[25, "CONFUSION_SIDE_EFFECT"]],
};

// ...and the effects for "always", which are status MOVES rather than side
// effects: they check accuracy and do nothing else, so they belong to a move
// with no power.
const ALWAYS_EFFECTS = {
  SLP: "SLEEP_EFFECT", PSN: "POISON_EFFECT", PAR: "PARALYZE_EFFECT",
  CONFUSION: "CONFUSION_EFFECT",
};

// "1 step" / "3 steps". A step list is short enough that "step(s)" is read
// far more often than it saves.
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

// A chance out of 256 as the percentage a person would say.
const chancePct = (n) => Math.round((n / 256) * 100);
const pctChance = (p) => Math.max(1, Math.min(256, Math.round((p / 100) * 256)));

const allMoves = () => P.entries.filter((e) => e.registry === "moves");
const moveName = (m) => m?.data?.name || m?.id || "(unnamed)";
const isMoveDraft = (m) => !!m && m === P.moveDraft;

function curMove() {
  if (P.sel.move === "draft") return P.moveDraft;
  return allMoves().find((m) => m._uid === P.sel.move) || null;
}

// The move indices the game already uses. The engine reads a move by id, but
// the index is what a save file stores in a party Pokemon's move slots, so a
// new move needs one nothing else has claimed.
function freeMoveIndex() {
  const used = new Set();
  for (const r of Object.values(GAME?.moves || {})) if (r.index) used.add(r.index);
  for (const m of allMoves()) if (m.data?.index) used.add(m.data.index);
  if (P.moveDraft?.data?.index) used.add(P.moveDraft.data.index);
  let n = 166;                        // the 165 are taken; start after them
  while (used.has(n) && n < 255) n++;
  return n;
}

/**
 * A new move, pre-filled with something that already works.
 *
 * A plain 60-power Normal attack: the most ordinary thing in the game, which
 * makes it the right thing to start from. Every required field carries a
 * value so the record is exportable the moment it has a name.
 */
function blankMove() {
  return {
    _uid: uid(), registry: "moves", verb: "register", id: "",
    _fx: { mode: "none" },
    _anim: { source: "game", id: "" },
    data: {
      name: "", type: "NORMAL", power: 60, accuracy: 100, pp: 20,
      index: freeMoveIndex(), effect: "NO_ADDITIONAL_EFFECT",
      anim: { sound: "", pitch: 0, tempo: 128 },
    },
  };
}

/* --------------------------------------------------------- what is normal -- */

/**
 * The game's own moves, split into the two groups worth comparing against.
 *
 * A 60-power attack and a status move are not the same kind of thing, and
 * averaging them together is what makes "is this too strong" useless: half
 * the list has no power at all and would drag every reading down. Measured at
 * runtime for the same reason the species meter is -- a table of thresholds
 * in this file would quietly rot the first time the extract changed.
 */
function vanillaMoveRows() {
  const rows = Object.values(GAME?.moves || {});
  return {
    damaging: rows.filter((r) => (r.power || 0) > 0),
    status: rows.filter((r) => !(r.power || 0)),
    all: rows,
  };
}

// Percentiles of one field across a set of moves, in the shape statBar takes.
function moveBand(rows, key) {
  const v = rows.map((r) => Number(r[key]) || 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  return { sorted: v, lo: at(0.1), mid: at(0.5), hi: at(0.9), min: v[0], max: v[v.length - 1], n: v.length };
}

// Which of the game's own moves this one lands nearest, so the reading has
// something concrete beside it rather than only a percentage.
function nearestMoves(rows, key, value, n = 3) {
  return [...rows]
    .sort((a, b) => Math.abs((a[key] || 0) - value) - Math.abs((b[key] || 0) - value))
    .slice(0, n)
    .map((r) => `${r.name || r.id} ${r[key] || 0}`);
}

/* -------------------------------------------------------------- effects -- */

// Plain English for the effects a person is likely to reach for. The rest
// fall back to their id prettified, which is still better than nothing and
// does not pretend to a completeness this list would lose the moment the
// engine gained an effect.
const EFFECT_LABEL = {
  NO_ADDITIONAL_EFFECT: "Just damage, nothing else",
  ATTACK_UP1_EFFECT: "Raises the user's Attack",
  ATTACK_UP2_EFFECT: "Raises the user's Attack sharply",
  DEFENSE_UP1_EFFECT: "Raises the user's Defense",
  DEFENSE_UP2_EFFECT: "Raises the user's Defense sharply",
  SPEED_UP2_EFFECT: "Raises the user's Speed sharply",
  SPECIAL_UP1_EFFECT: "Raises the user's Special",
  SPECIAL_UP2_EFFECT: "Raises the user's Special sharply",
  EVASION_UP1_EFFECT: "Raises the user's evasion",
  ATTACK_DOWN1_EFFECT: "Lowers the target's Attack",
  DEFENSE_DOWN1_EFFECT: "Lowers the target's Defense",
  DEFENSE_DOWN2_EFFECT: "Lowers the target's Defense sharply",
  SPEED_DOWN1_EFFECT: "Lowers the target's Speed",
  ACCURACY_DOWN1_EFFECT: "Lowers the target's accuracy",
  ATTACK_DOWN_SIDE_EFFECT: "1 in 3 chance of lowering the target's Attack",
  DEFENSE_DOWN_SIDE_EFFECT: "1 in 3 chance of lowering the target's Defense",
  SPEED_DOWN_SIDE_EFFECT: "1 in 3 chance of lowering the target's Speed",
  SPECIAL_DOWN_SIDE_EFFECT: "1 in 3 chance of lowering the target's Special",
  SLEEP_EFFECT: "Puts the target to sleep",
  POISON_EFFECT: "Poisons the target",
  PARALYZE_EFFECT: "Paralyses the target",
  CONFUSION_EFFECT: "Confuses the target",
  BURN_SIDE_EFFECT1: "1 in 10 chance of burning the target",
  BURN_SIDE_EFFECT2: "3 in 10 chance of burning the target",
  FREEZE_SIDE_EFFECT1: "1 in 10 chance of freezing the target",
  PARALYZE_SIDE_EFFECT1: "1 in 10 chance of paralysing the target",
  PARALYZE_SIDE_EFFECT2: "3 in 10 chance of paralysing the target",
  POISON_SIDE_EFFECT1: "1 in 5 chance of poisoning the target",
  POISON_SIDE_EFFECT2: "2 in 5 chance of poisoning the target",
  FLINCH_SIDE_EFFECT1: "1 in 10 chance of making the target flinch",
  FLINCH_SIDE_EFFECT2: "3 in 10 chance of making the target flinch",
  CONFUSION_SIDE_EFFECT: "1 in 10 chance of confusing the target",
  DRAIN_HP_EFFECT: "Heals the user by half the damage dealt",
  DREAM_EATER_EFFECT: "Only works on a sleeping target; heals by half",
  RECOIL_EFFECT: "The user takes a quarter of the damage back",
  EXPLODE_EFFECT: "The user faints; halves the target's Defense first",
  HYPER_BEAM_EFFECT: "The user must recharge the turn after",
  CHARGE_EFFECT: "Takes a turn to charge, then hits",
  FLY_EFFECT: "Vanishes for a turn, then hits",
  TRAPPING_EFFECT: "Traps the target for 2-5 turns",
  TWO_TO_FIVE_ATTACKS_EFFECT: "Hits 2-5 times",
  ATTACK_TWICE_EFFECT: "Hits twice",
  TWINEEDLE_EFFECT: "Hits twice, second hit may poison",
  THRASH_PETAL_DANCE_EFFECT: "Attacks 3-4 turns, then the user is confused",
  JUMP_KICK_EFFECT: "The user hurts itself on a miss",
  OHKO_EFFECT: "Knocks the target out in one hit, or misses",
  SUPER_FANG_EFFECT: "Halves the target's current HP",
  SPECIAL_DAMAGE_EFFECT: "Fixed damage — set the number below",
  SWIFT_EFFECT: "Never misses",
  HEAL_EFFECT: "Heals the user to full",
  LEECH_SEED_EFFECT: "Drains the target every turn",
  LIGHT_SCREEN_EFFECT: "Halves special damage taken",
  REFLECT_EFFECT: "Halves physical damage taken",
  MIST_EFFECT: "Blocks stat drops",
  HAZE_EFFECT: "Clears every stat change on both sides",
  SUBSTITUTE_EFFECT: "Spends HP on a decoy",
  FOCUS_ENERGY_EFFECT: "Meant to raise crits (famously does the opposite)",
  DISABLE_EFFECT: "Stops one of the target's moves working",
  MIMIC_EFFECT: "Copies one of the target's moves",
  MIRROR_MOVE_EFFECT: "Uses whatever the target just used",
  METRONOME_EFFECT: "Uses a random move",
  TRANSFORM_EFFECT: "Becomes a copy of the target",
  CONVERSION_EFFECT: "Takes the target's types",
  SPLASH_EFFECT: "Does nothing whatsoever",
  PAY_DAY_EFFECT: "Scatters money to pick up after the fight",
  RAGE_EFFECT: "Locks in, and grows stronger each time it is hit",
  BIDE_EFFECT: "Waits two turns, then hits back double",
  SWITCH_AND_TELEPORT_EFFECT: "Ends a wild battle / switches a trainer's",
};

const effectLabel = (id) =>
  EFFECT_LABEL[id] || String(id || "").replace(/_EFFECT\d*$/, "").replace(/_/g, " ").toLowerCase();

// What a move's effect actually does, in a phrase. An effect Oak's Lab wrote
// has no entry in the table above and prettifying its generated id would read
// as "ember burst brn 45", so the guided answer says it instead.
function effectSummary(m, chosen) {
  if (!chosen.custom) return effectLabel(chosen.id);
  const fx = m._fx || {};
  const row = statusRow(fx.status);
  return `${fx.chance}% chance of ${(row?.label || fx.status).toLowerCase()}`;
}

/**
 * Which effect id a move should carry, given the guided answer in `_fx`.
 *
 * Returns { id, custom } -- `custom` set means nothing in the game means this
 * and Oak's Lab has to write it, which the step then says out loud.
 */
function effectFor(m) {
  const fx = m._fx || {};
  if (fx.mode === "preset") return { id: fx.preset || "NO_ADDITIONAL_EFFECT", custom: false };
  if (fx.mode !== "status" || !fx.status) return { id: "NO_ADDITIONAL_EFFECT", custom: false };

  const pct = Math.max(1, Math.min(100, fx.chance ?? 10));
  if (pct >= 100 && ALWAYS_EFFECTS[fx.status]) return { id: ALWAYS_EFFECTS[fx.status], custom: false };

  for (const [n, id] of VANILLA_SIDE_EFFECTS[fx.status] || []) {
    if (chancePct(n) === pct) return { id, custom: false };
  }
  // Confusion has no exposed way to roll at another chance (the engine's
  // confuse() is not on the ctx a mod's effect receives), so it snaps to the
  // one the game has rather than writing a function that cannot work.
  if (fx.status === "CONFUSION") return { id: "CONFUSION_SIDE_EFFECT", custom: false };
  if (fx.status === "SLP") return { id: "SLEEP_EFFECT", custom: false };
  return { id: customEffectId(m), custom: true };
}

const customEffectId = (m) =>
  (m.id || idFromName(m.data.name) || "MOVE") + "_" + (m._fx?.status || "FX") + "_"
  + Math.max(1, Math.min(100, m._fx?.chance ?? 10));

// Keep the record's own `effect` field in step with the guided answer, so the
// All-records tab and the export never disagree with what step 4 shows.
function syncMoveEffect(m) {
  const chosen = effectFor(m);
  if (m.data.effect !== chosen.id) { m.data.effect = chosen.id; touch(); }
}

/**
 * The move_effects records this mod has to ship, as Lua source.
 *
 * Only the chances the game does not already have land here. The body is the
 * engine's own statusSide/flinchSide written out longhand -- including the
 * type check, which is the rule that surprises people (a Fire move cannot
 * burn a Fire-type, so a 100% burn on a Fire move still does nothing).
 */
function moveEffectRecords() {
  const out = [];
  const seen = new Set();
  for (const m of allMoves()) {
    const chosen = effectFor(m);
    if (!chosen.custom || seen.has(chosen.id)) continue;
    seen.add(chosen.id);
    const fx = m._fx;
    const threshold = pctChance(fx.chance);
    const lines = [];
    lines.push(`    kind = "secondary",`);
    lines.push(`    run = function(ctx)`);
    if (fx.status === "FLINCH") {
      lines.push(`      if ctx.target.substituteHP then return {} end`);
      lines.push(`      if ctx.rng(0, 255) < ${threshold} then ctx.target.flinched = true end`);
      lines.push(`      return {}`);
    } else {
      lines.push(`      -- ${fx.chance}% -- ${threshold} out of 256, the way the engine rolls it`);
      lines.push(`      if ctx.rng(0, 255) >= ${threshold} then return {} end`);
      lines.push(`      return ctx.inflict(ctx.target, ${luaStr(fx.status)}, {`);
      lines.push(`        secondary = true, moveType = ctx.move.type, source = ctx.move.id,`);
      lines.push(`      })`);
    }
    lines.push(`    end,`);
    out.push({ id: chosen.id, body: lines.join("\n"), why: `${fx.chance}% ${fx.status} for ${moveName(m)}` });
  }
  return out;
}

/* ------------------------------------------------------------ animations -- */

const animLib = () => GAME?.anims || null;

// How long each screen effect blocks the animation for, from the engine's own
// AnimPlayer table (which counted them off the original assembly's delays).
// Anything not listed gets the same fallback the engine uses.
const SE_PAUSE_FRAMES = 8;
const SE_FRAMES = {
  SE_DARK_SCREEN_FLASH: 4, SE_FLASH_SCREEN_LONG: 48,
  SE_DARK_SCREEN_PALETTE: 0, SE_LIGHT_SCREEN_PALETTE: 0,
  SE_DARKEN_MON_PALETTE: 0, SE_RESET_SCREEN_PALETTE: 0,
  SE_SHAKE_SCREEN: 72, SE_SHAKE_ENEMY_HUD: 44, SE_DELAY_ANIMATION_10: 10,
  SE_SLIDE_MON_OFF: 24, SE_SLIDE_ENEMY_MON_OFF: 24, SE_SLIDE_MON_HALF_OFF: 19,
  SE_SLIDE_MON_UP: 14, SE_SLIDE_MON_DOWN: 21, SE_SLIDE_MON_DOWN_AND_HIDE: 19,
  SE_MOVE_MON_HORIZONTALLY: 3, SE_RESET_MON_POSITION: 3,
  SE_SHAKE_BACK_AND_FORTH: 96, SE_BOUNCE_UP_AND_DOWN: 108,
  SE_SQUISH_MON_PIC: 26, SE_MINIMIZE_MON: 6,
  SE_SHOW_MON_PIC: 3, SE_SHOW_ENEMY_MON_PIC: 3,
  SE_HIDE_MON_PIC: 3, SE_HIDE_ENEMY_MON_PIC: 3,
  SE_BLINK_MON: 60, SE_BLINK_ENEMY_MON: 60,
  SE_FLASH_MON_PIC: 4, SE_FLASH_ENEMY_MON_PIC: 4,
  SE_TRANSFORM_MON: 4, SE_SUBSTITUTE_MON: 3, SE_WAVY_SCREEN: 255,
};

// The screen effects worth offering when building one by hand: the ones that
// read clearly on their own. The full list is longer and mostly plumbing
// (palette writes that only mean something in pairs).
const SE_OFFERED = [
  ["SE_DARK_SCREEN_FLASH", "Flash the screen"],
  ["SE_FLASH_SCREEN_LONG", "Flash the screen, long"],
  ["SE_SHAKE_SCREEN", "Shake the screen"],
  ["SE_SHAKE_ENEMY_HUD", "Shake the target's health bar"],
  ["SE_DELAY_ANIMATION_10", "Pause for a moment"],
  ["SE_BLINK_MON", "Blink the user"],
  ["SE_BLINK_ENEMY_MON", "Blink the target"],
  ["SE_SLIDE_MON_OFF", "Slide the user off screen"],
  ["SE_SLIDE_MON_UP", "Nudge the user up"],
  ["SE_SLIDE_MON_DOWN", "Nudge the user down"],
  ["SE_SQUISH_MON_PIC", "Squash the user"],
  ["SE_BOUNCE_UP_AND_DOWN", "Bounce the user"],
  ["SE_SHAKE_BACK_AND_FORTH", "Shake the user back and forth"],
  ["SE_MINIMIZE_MON", "Shrink the user"],
  ["SE_WAVY_SCREEN", "Ripple the whole screen"],
];
const seLabel = (id) => (SE_OFFERED.find((s) => s[0] === id) || [])[1]
  || String(id).replace(/^SE_/, "").replace(/_/g, " ").toLowerCase();

const animWrap = (v) => ((v % 256) + 256) % 256;

// resolveTransform: the attacker's side decides what NORMAL and ENEMY mean.
// Every animation in the game is authored from the player's point of view, so
// an enemy using it gets the mirrored one.
function resolveTransform(subType, isPlayer) {
  if (subType === "ENEMY") return isPlayer ? "HFLIP" : "NORMAL";
  return isPlayer ? "NORMAL" : subType;
}

// DrawFrameBlock: one 8x8 tile of a frame block, anchored at a base coord and
// put through the subanimation's transform. Coordinates are OAM space
// (screen x + 8, y + 16), which is why the drawing code subtracts them back.
function placeTile(transform, bc, t, tileset) {
  let x, y, xf, yf;
  if (transform === "HVFLIP") {
    y = animWrap(136 - animWrap(bc.y + t.y));
    x = animWrap(168 - animWrap(bc.x + t.x));
    if (!t.xflip && !t.yflip) { xf = true; yf = true; }
    else if (t.xflip && !t.yflip) { xf = false; yf = true; }
    else if (t.yflip && !t.xflip) { xf = true; yf = false; }
    else { xf = false; yf = false; }
  } else if (transform === "HFLIP") {
    y = animWrap(animWrap(bc.y + t.y) + 40);
    x = animWrap(168 - animWrap(bc.x + t.x));
    xf = !t.xflip; yf = !!t.yflip;
  } else if (transform === "COORDFLIP") {
    y = animWrap(animWrap(136 - bc.y) + t.y);
    x = animWrap(animWrap(168 - bc.x) + t.x);
    xf = !!t.xflip; yf = !!t.yflip;
  } else {                                  // NORMAL, and REVERSE which only reorders
    y = animWrap(bc.y + t.y);
    x = animWrap(bc.x + t.x);
    xf = !!t.xflip; yf = !!t.yflip;
  }
  return { x, y, tile: t.tile, ts: tileset, xf, yf };
}

/**
 * Turn a move's `seq` into a list of timed frames.
 *
 * A port of the engine's AnimPlayer:start -- the same OAM buffer simulation,
 * the same four frame-block modes, so what plays here is what plays there.
 * The sprite-emitter effects (spiralling balls, falling petals) and the
 * per-move screen-flash quirks are left out: they are compiled from hand
 * written trajectories in the original and are not something this tool lets
 * anybody author, so faking them would only make the preview lie in a
 * different direction. They show up in the effect list under the screen
 * instead.
 */
function compileAnim(seq, lib, isPlayer) {
  const steps = [], effects = [], sounds = [];
  let oam = [], oamMax = 0, frame = 0;

  const emit = (dur, override) => {
    if (dur < 1) dur = 1;
    const sprites = override || oam.slice(0, oamMax).filter(Boolean);
    steps.push({ dur, sprites, frame });
    frame += dur;
  };

  for (const row of seq || []) {
    if (row.sound) sounds.push({ sound: row.sound, frame });
    if (row.effect) {
      const known = SE_FRAMES[row.effect];
      const dur = known === undefined ? SE_PAUSE_FRAMES : known;
      effects.push({ effect: row.effect, frame, dur });
      if (dur > 0) emit(dur);
      continue;
    }
    const sub = lib.subanims?.[row.subanim];
    if (!sub?.blocks?.length) continue;
    const transform = resolveTransform(sub.type, isPlayer);
    const order = transform === "REVERSE" ? [...sub.blocks].reverse() : sub.blocks;
    let dest = 0;
    for (const entry of order) {
      const fb = lib.frameBlocks?.[entry.block];
      const bc = lib.baseCoords?.[entry.coord];
      if (!fb || !bc) continue;
      for (let j = 0; j < fb.length; j++) oam[dest + j] = placeTile(transform, bc, fb[j], row.tileset || 0);
      if (dest + fb.length > oamMax) oamMax = dest + fb.length;
      const delay = row.delay || 1;
      if (entry.mode === 2) {                       // accumulate, nothing shown yet
        dest += fb.length;
      } else if (entry.mode === 3) {                // show and keep
        emit(delay); dest += fb.length;
      } else if (entry.mode === 4) {                // show; the next block overwrites
        emit(delay);
      } else {                                      // 0/1: show, then wipe the buffer
        emit(delay + 1);
        oam = []; oamMax = 0; dest = 0;
      }
    }
  }
  return { steps, effects, sounds, frames: frame };
}

/**
 * Which of the 177 base coordinates an animation's own rows land on, in the
 * order they first appear -- so a freeform effect can be put in the SAME
 * spot as the thing it is replacing by typing the same number, rather than
 * eyeballing a click against a picture that no longer has the original next
 * to it for comparison.
 */
function vanillaAnimCoords(seq, lib) {
  const seen = new Set();
  for (const row of seq || []) {
    const sub = lib.subanims?.[row.subanim];
    for (const block of sub?.blocks || []) if (block.coord != null) seen.add(block.coord);
  }
  return [...seen];
}

/**
 * What a move's animation actually is right now, resolved for playing.
 *
 * Only the "borrow one of the game's" path resolves through here. A
 * freeform strip (step 5's other option) is not made of subanims and frame
 * blocks at all, so it has its own preview -- see freeformPreview below.
 */
function moveAnimFor(m) {
  const lib = animLib();
  if (!lib) return null;
  const a = m._anim || {};
  if (a.source === "freeform") return null;
  const vanilla = lib.moveAnims?.[a.id || m.id];
  return vanilla ? { seq: vanilla.seq, lib, own: false } : null;
}

/* ------------------------------------------------------- the anim preview -- */

// One tile sheet as an <img>, decoded once. The vanilla sheets are under a
// kilobyte each but a preview redraws sixty times a second, so decoding per
// frame would be the one expensive thing on this screen.
const animSheetCache = new Map();
// Keyed by the bytes themselves, so the game's sheet 0 and sheet 2 -- which
// are the same file with a different tile count -- decode once, and a sheet
// the user re-imports gets a new entry rather than the old picture.
const sheetKey = (sheet) => "anim:" + sheet.png.length + ":" + sheet.png.slice(0, 24);
function animSheetImage(key, b64) {
  if (animSheetCache.has(key)) return animSheetCache.get(key);
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  animSheetCache.set(key, img);
  return img;
}

const GB_SCREEN_W = 160, GB_SCREEN_H = 144;

/**
 * The battle screen an animation happens on top of.
 *
 * Not decoration. These tiles are four Game Boy greys with the lightest one
 * transparent, and the screen they are drawn on is white -- so on any dark
 * background most of an animation is invisible, which is the opposite of a
 * preview. The two dashed boxes are where the Pokemon stand, and half the
 * animations in the game are aimed at one of them.
 */
function drawBattleGround(ctx, scale, inverted, message) {
  ctx.save();
  ctx.scale(scale, scale);
  // AnimationFlashScreen inverts the hardware palette, which is every pixel
  // on screen, not just the outlines -- `filter` does the same thing to
  // whatever gets drawn under it without threading an "inverted" branch
  // through every fillRect/fillText in drawBattleChrome.
  ctx.filter = inverted ? "invert(1)" : "none";
  drawBattleChrome(ctx, "FOE", message || "");
  ctx.filter = "none";
  ctx.restore();
}

/**
 * The Game Boy screen with the animation running on it.
 *
 * Returns the element and a `play()`, so the caller can put a button
 * somewhere sensible rather than having one forced into the middle of a form.
 * Nothing runs until asked: an autoplaying animation on a page with eight
 * steps on it is a distraction, not a preview.
 */
function animPreview(resolved, o = {}) {
  const scale = o.scale || 2;
  const cv = el("canvas", {
    class: "battlemock", width: GB_SCREEN_W * scale, height: GB_SCREEN_H * scale,
  });
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const compiled = resolved ? compileAnim(resolved.seq, resolved.lib, true) : null;
  let raf = null;

  // AnimationFlashScreen is two frames inverted then two white, and the long
  // one is that on a loop. Both read as "the screen goes dark", which is the
  // part worth showing -- the palette rows around them are register writes
  // whose whole effect is on a Pokemon picture this preview does not have.
  const flashAt = (frame) => (compiled?.effects || []).some((e) =>
    (e.effect === "SE_DARK_SCREEN_FLASH" || e.effect === "SE_FLASH_SCREEN_LONG")
    && frame >= e.frame && frame < e.frame + Math.min(e.dur, 6));

  const drawFrame = (frame) => {
    ctx.imageSmoothingEnabled = false;
    drawBattleGround(ctx, scale, flashAt(frame), o.message);
    if (!compiled) return;
    // Which compiled step covers this frame. Walked rather than indexed:
    // a step lasts several frames and there are only a few dozen of them.
    let at = 0, step = null;
    for (const s of compiled.steps) {
      if (frame >= at && frame < at + s.dur) { step = s; break; }
      at += s.dur;
    }
    if (!step) return;
    for (const s of step.sprites) {
      // The hardware hides sprites at the OAM extremes, and wrapped
      // coordinates rely on that to park tiles off screen.
      if (!(s.x > 0 && s.x < 168 && s.y > 0 && s.y < 160)) continue;
      const sheet = resolved.lib.tilesheets?.[s.ts];
      if (!sheet || s.tile >= sheet.tiles) continue;
      const img = animSheetImage(sheetKey(sheet), sheet.png);
      if (!img.complete || !img.naturalWidth) continue;
      const cols = Math.floor(sheet.w / 8);
      const sx = (s.tile % cols) * 8, sy = Math.floor(s.tile / cols) * 8;
      ctx.save();
      ctx.translate((s.x - 8) * scale, (s.y - 16) * scale);
      ctx.scale(s.xf ? -1 : 1, s.yf ? -1 : 1);
      ctx.drawImage(img, sx, sy, 8, 8, s.xf ? -8 * scale : 0, s.yf ? -8 * scale : 0, 8 * scale, 8 * scale);
      ctx.restore();
    }
  };

  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };
  const play = () => {
    stop();
    // The sound starts with the picture, which is what the engine does: the
    // first subanimation row of every animation carries the move's sound.
    if (o.onPlaySound) o.onPlaySound();
    const total = compiled?.frames || 0;
    const start = performance.now();
    const loop = () => {
      const frame = Math.floor((performance.now() - start) / (1000 / 60));
      if (frame > total) { drawFrame(total); raf = null; return; }
      drawFrame(frame);
      raf = requestAnimationFrame(loop);
    };
    loop();
  };

  // Something has to be on the canvas before the first press, or the step
  // looks broken. The last frame of the first burst is the most legible
  // still the animation has.
  const firstWithSprites = (compiled?.steps || []).find((s) => s.sprites.length);
  drawFrame(firstWithSprites ? firstWithSprites.frame : 0);
  // A sheet that has not decoded yet leaves that first draw empty, so redraw
  // once each one arrives rather than showing an empty screen until first play.
  for (const [, sheet] of Object.entries(resolved?.lib?.tilesheets || {})) {
    const img = animSheetImage(sheetKey(sheet), sheet.png);
    if (!img.complete) img.addEventListener("load", () => {
      if (!raf) drawFrame(firstWithSprites ? firstWithSprites.frame : 0);
    }, { once: true });
  }

  return { el: el("div", { class: "battlewrap" }, cv), play, stop, compiled };
}

/* ------------------------------------------- the game's art, as a strip -- */

/**
 * Render one of the game's own animations out as a filmstrip PNG.
 *
 * The point is the paint-over workflow, which is how anybody actually makes
 * a first animation: take something that already reads as an explosion, open
 * it in an art program, paint over the frames, bring it back in. Exporting
 * the raw 128x40 tile sheet does not do that -- it is a grid of unordered
 * 8x8 cells shared by every animation in the game, and no part of it looks
 * like the thing you picked.
 *
 * So this replays the animation through the same compiler the preview uses
 * and photographs each visible frame, giving back the picture as it appears
 * on screen, in play order. Every frame is cropped to ONE bounding box
 * covering all of them, so they stay in register with each other rather than
 * each being trimmed to its own art and drifting.
 */
async function renderVanillaAnimStrip(animId) {
  const lib = animLib();
  const anim = lib?.moveAnims?.[animId];
  if (!anim?.seq) return null;
  const compiled = compileAnim(anim.seq, lib, true);

  // Every sheet this animation touches has to have decoded before anything
  // is photographed, or the strip comes out blank.
  const sheets = new Set();
  for (const s of compiled.steps) for (const sp of s.sprites) sheets.add(sp.ts);
  await Promise.all([...sheets].map((ts) => {
    const sheet = lib.tilesheets?.[ts];
    if (!sheet) return null;
    const img = animSheetImage(sheetKey(sheet), sheet.png);
    if (img.complete && img.naturalWidth) return null;
    return new Promise((res) => {
      img.addEventListener("load", res, { once: true });
      img.addEventListener("error", res, { once: true });
    });
  }).filter(Boolean));

  // One canvas per distinct visible frame. Consecutive identical steps are
  // merged: the engine holds a frame by repeating it, and a strip with the
  // same picture four times running is four times the painting for nothing.
  // What that repetition WAS is kept as the frame's hold, which is where the
  // "held N game-frames each" reading below comes from.
  const frames = [];
  let lastKey = null;
  for (const step of compiled.steps) {
    if (!step.sprites.length) { lastKey = null; continue; }
    const key = JSON.stringify(step.sprites);
    if (key === lastKey) { frames[frames.length - 1].dur += step.dur; continue; }
    lastKey = key;
    const cv = el("canvas", { width: GB_SCREEN_W, height: GB_SCREEN_H });
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    for (const s of step.sprites) {
      if (!(s.x > 0 && s.x < 168 && s.y > 0 && s.y < 160)) continue;
      const sheet = lib.tilesheets?.[s.ts];
      if (!sheet || s.tile >= sheet.tiles) continue;
      const img = animSheetImage(sheetKey(sheet), sheet.png);
      if (!img.complete || !img.naturalWidth) continue;
      const cols = Math.floor(sheet.w / 8);
      const sx = (s.tile % cols) * 8, sy = Math.floor(s.tile / cols) * 8;
      ctx.save();
      ctx.translate(s.x - 8, s.y - 16);
      ctx.scale(s.xf ? -1 : 1, s.yf ? -1 : 1);
      ctx.drawImage(img, sx, sy, 8, 8, s.xf ? -8 : 0, s.yf ? -8 : 0, 8, 8);
      ctx.restore();
    }
    frames.push({ cv, dur: step.dur });
  }
  if (!frames.length) return null;

  let x0 = GB_SCREEN_W, y0 = GB_SCREEN_H, x1 = -1, y1 = -1;
  for (const { cv } of frames) {
    const d = cv.getContext("2d").getImageData(0, 0, GB_SCREEN_W, GB_SCREEN_H).data;
    for (let y = 0; y < GB_SCREEN_H; y++) {
      for (let x = 0; x < GB_SCREEN_W; x++) {
        if (d[(y * GB_SCREEN_W + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;

  /* Boxed on an exact grid: a 1px guide line around and between every cell,
     so the strip opens in an art program with the edges of each frame
     visible -- "what you can work in" is a drawn box, not something to be
     measured. The guides ARE the grid: the importer finds the cells by
     reading them back rather than guessing at islands or being told a cell
     size, so a strip stays self-describing even after a round trip through
     a paint program that knows nothing about any of this.

     Magenta because the battle art is four greys and transparency, so it
     cannot collide with anything real, and because keying on it is a
     convention people already know from spritework. */
  const fw = x1 - x0 + 1, fh = y1 - y0 + 1;
  const out = el("canvas", { width: fw + 2, height: 1 + frames.length * (fh + 1) });
  const oc = out.getContext("2d");
  oc.imageSmoothingEnabled = false;
  oc.fillStyle = `rgb(${GUIDE_RGB.join(",")})`;
  oc.fillRect(0, 0, out.width, out.height);
  frames.forEach(({ cv }, i) => {
    const dy = 1 + i * (fh + 1);
    oc.clearRect(1, dy, fw, fh);          // the cell itself is transparent
    oc.drawImage(cv, x0, y0, fw, fh, 1, dy, fw, fh);
  });

  // How long each frame is held, in 60ths. Uniform for most of the game's
  // animations, which is what makes a single "speed" slider the right shape
  // for a hand-painted one.
  const holds = frames.map((f) => f.dur);
  const uniform = holds.every((d) => d === holds[0]);
  const rate = uniform ? holds[0]
    : Math.max(1, Math.round(holds.reduce((n, d) => n + d, 0) / holds.length));
  return {
    png: pngOf(out), frameW: fw, frameH: fh, frames: frames.length,
    holds, rate, uniform,
  };
}

/**
 * Pick one of the game's animations and download it as a strip to paint over.
 */
function exportAnimStripDialog(m) {
  const lib = animLib();
  const ids = Object.keys(lib?.moveAnims || {}).sort();
  if (!ids.length) { toast("No animation data — regenerate gamedata.json", true); return; }

  // Whatever this move is already pointing at, since that is overwhelmingly
  // the one being exported -- you export the art of the animation you just
  // borrowed in order to paint your own version of it.
  const a = m._anim || {};
  const start = ids.includes(a.id) ? a.id : ids.includes(m.id) ? m.id : ids[0];

  const body = el("div", {});
  body.append(el("p", { class: "hint" },
    "Photographs the animation frame by frame and hands you the result as a strip — the picture as "
    + "it appears on screen, in play order, not the raw tile sheet. Paint over it, then bring it "
    + "back in with “Paint the strip”."));
  body.append(el("p", { class: "hint" },
    "Every cell is boxed with a guide line, so the edges of each frame are visible while you work "
    + "— and those same lines are how the import reads the cells back, so what you paint returns "
    + "exactly as it left. Paint inside the boxes; the magenta itself is stripped on the way in."));
  body.append(el("p", { class: "hint" },
    "Frames the game holds still are exported once rather than repeated, and everything is cropped "
    + "to one shared box so the frames stay lined up with each other."));

  const posInfo = el("div", { class: "hint" });
  const updatePosInfo = () => {
    const anim = lib.moveAnims?.[sel.value];
    const coords = anim ? vanillaAnimCoords(anim.seq, lib) : [];
    posInfo.textContent = coords.length
      ? `Draws at position ${coords.join(", ")} — the number to type into a freeform effect's `
        + "Position field for the same spot."
      : "";
  };

  const fill = (needle) => {
    sel.textContent = "";
    for (const id of ids) {
      if (needle && !id.toLowerCase().includes(needle)) continue;
      sel.append(el("option", { value: id, selected: id === start }, id));
    }
    updatePosInfo();
  };
  const sel = el("select", { onchange: updatePosInfo });
  body.append(el("input", {
    type: "search", placeholder: `search ${ids.length}…`,
    oninput: (e) => fill(e.target.value.trim().toLowerCase()),
  }));
  fill("");
  body.append(sel);
  body.append(posInfo);

  const status = el("div", { class: "hint" });
  body.append(status);
  body.append(el("div", { class: "row", style: "margin-top:10px" },
    el("button", {
      class: "primary fixed",
      onclick: async () => {
        const id = sel.value;
        if (!id) return;
        status.className = "hint";
        status.textContent = "Rendering " + id + "…";
        const strip = await renderVanillaAnimStrip(id);
        if (!strip) {
          status.className = "hint bad";
          status.textContent = id + " draws nothing of its own — it is all screen effects, so there "
            + "is no picture to export. Try another.";
          return;
        }
        exportArt({ png: strip.png },
          `${id.toLowerCase()}_${strip.frames}f_${strip.frameW}x${strip.frameH}`);
        // Matching the source's own pacing is almost always what is wanted,
        // and is the one number the strip itself cannot carry. Position only
        // follows along when the source draws at exactly one spot -- copying
        // one of several would just be a guess.
        const anim = lib.moveAnims?.[id];
        const coords = anim ? vanillaAnimCoords(anim.seq, lib) : [];
        const isFreeform = m._anim?.source === "freeform";
        const tookRate = isFreeform && m._anim.rate !== strip.rate;
        const tookCoord = isFreeform && coords.length === 1 && m._anim.coord !== coords[0];
        if (tookRate) m._anim.rate = strip.rate;
        if (tookCoord) m._anim.coord = coords[0];
        if (tookRate || tookCoord) touch();
        closeDialog();
        if (tookRate || tookCoord) renderMoveTab();
        toast(`${strip.frames} frames of ${strip.frameW}x${strip.frameH}, held ${strip.rate} `
          + `game-frame${strip.rate === 1 ? "" : "s"} each`
          + (tookRate && tookCoord ? " — speed and position set to match"
            : tookRate ? " — speed set to match"
            : tookCoord ? " — position set to match" : ""));
      },
    }, "Export it"),
    el("button", { class: "fixed", onclick: closeDialog }, "Cancel")));
  dialog("Export the game's art to paint over", body);
}

/* --------------------------------------------------------- freeform anims -- */

/**
 * The vanilla base coordinates, purely as places to stand -- the lattice a
 * freeform effect still anchors to even though it owes nothing else to the
 * frame-block system. Kept as the same 177 points so "where do things
 * usually happen" stays a curated set instead of every pixel on the screen.
 */
const nearestCoordIndex = (lib, ox, oy) => {
  let best = 0, bestDist = Infinity;
  for (const [i, c] of Object.entries(lib.baseCoords || {})) {
    const d = (c.x - ox) ** 2 + (c.y - oy) ** 2;
    if (d < bestDist) { bestDist = d; best = Number(i); }
  }
  return best;
};

/**
 * The battle screen with a freeform strip playing on it, or a crosshair
 * where it will play from if there is nothing to play yet.
 *
 * Position is chosen by clicking this canvas rather than reading a number
 * off a list of 177 -- `o.onPick` gets the click converted to the same
 * OAM-space coordinates baseCoords itself uses, and the caller resolves it
 * to the nearest one and re-renders.
 */
function freeformPreview(a, o = {}) {
  const scale = o.scale || 2;
  const cv = el("canvas", { class: "battlemock", width: GB_SCREEN_W * scale, height: GB_SCREEN_H * scale });
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const lib = animLib();
  const coord = lib?.baseCoords?.[a.coord ?? 0] || { x: 84, y: 60 };
  const strip = a.strip;
  const img = strip ? animSheetImage("freeform:" + sheetKey({ png: strip.png }), strip.png) : null;

  const drawMarker = () => {
    ctx.save();
    ctx.strokeStyle = "#e08a2e";
    ctx.lineWidth = 1;
    const x = Math.round((coord.x - 8) * scale) + 0.5, y = Math.round((coord.y - 16) * scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y);
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
    ctx.stroke();
    ctx.restore();
  };

  const drawFrame = (i) => {
    ctx.imageSmoothingEnabled = false;
    drawBattleGround(ctx, scale, false, o.message);
    if (strip && img && img.complete && img.naturalWidth) {
      const fw = strip.frameW, fh = strip.frameH;
      // Centred left-right, standing on the point -- the same anchor an
      // overworld sprite uses against its own tile.
      const dx = (coord.x - 8 - fw / 2) * scale, dy = (coord.y - 16 - fh) * scale;
      ctx.drawImage(img, 0, i * fh, fw, fh, dx, dy, fw * scale, fh * scale);
    } else {
      drawMarker();
    }
  };

  // Once the move actually finishes, the game clears the screen rather than
  // holding its last frame -- so the preview does the same instead of
  // leaving a picture sitting there that never happened in play.
  const clearFrame = () => { ctx.imageSmoothingEnabled = false; drawBattleGround(ctx, scale, false, o.message); };

  let raf = null;
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };
  const play = () => {
    stop();
    if (!strip) return;
    if (o.onPlaySound) o.onPlaySound();
    const rate = Math.max(1, a.rate || 4);
    const total = strip.frames * rate;
    const start = performance.now();
    const loop = () => {
      const t = Math.floor((performance.now() - start) / (1000 / 60));
      if (t >= total) { clearFrame(); raf = null; return; }
      drawFrame(Math.min(strip.frames - 1, Math.floor(t / rate)));
      raf = requestAnimationFrame(loop);
    };
    loop();
  };

  drawFrame(0);
  if (img && !img.complete) img.addEventListener("load", () => { if (!raf) drawFrame(0); }, { once: true });

  if (o.onPick) {
    cv.style.cursor = "crosshair";
    cv.addEventListener("click", (e) => {
      const rect = cv.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * GB_SCREEN_W;
      const py = (e.clientY - rect.top) / rect.height * GB_SCREEN_H;
      o.onPick(px + 8, py + 16);
    });
  }

  return { el: el("div", { class: "battlewrap" }, cv), play, stop, frames: strip ? strip.frames : 0 };
}

/* -------------------------------------------------- what the mod exports -- */

/**
 * The battle_anims records a move borrowing one of the game's has to ship.
 *
 * A freeform (hand-painted) animation never reaches here -- there is no
 * battle_anims route for a new frame-block arrangement, only for borrowing
 * the game's own, so it exports through the freeform preamble instead (see
 * freeformRuntimePreamble/freeformRuntimeHooks below).
 */
function moveAnimRecords() {
  const out = [];
  for (const m of allMoves()) {
    const id = m.id || idFromName(m.data.name);
    if (!id) continue;
    const a = m._anim || {};
    if (a.source === "freeform" || m.verb !== "register" || !a.id) continue;
    // The engine looks an animation up by the MOVE's id and has no fallback,
    // so a new move with nothing registered under its own name plays
    // nothing at all. Copying the rows across is what makes "use
    // FLAMETHROWER's" mean it.
    const from = animLib()?.moveAnims?.[a.id];
    if (!from?.seq) continue;
    const seq = from.seq.map((row) => (row.sound ? { ...row, sound: id } : { ...row }));
    out.push({ id, data: { seq } });
  }
  return out;
}

const moveSheetFile = (m) =>
  "art/" + (m.id || idFromName(m.data.name) || "move").toLowerCase() + "_anim.png";

// Every move with a hand-painted animation that has something to actually
// play. A draft with the strip not painted yet is skipped rather than
// shipping a broken entry.
const freeformMoves = () => allMoves().filter((m) => m._anim?.source === "freeform" && m._anim.strip?.png);

// One strip per move -- unlike the old shared tile-sheet system, nothing
// here is deduplicated across moves, so the file name just follows the move.
function moveAnimArtFiles() {
  return freeformMoves().map((m) => ({ name: moveSheetFile(m), bytes: base64Bytes(m._anim.strip.png) }));
}

const moveSoundFile = (m) =>
  "audio/" + (m.id || idFromName(m.data.name) || "move").toLowerCase() + "_sound." + (m._soundImport?.ext || "ogg");

/**
 * A move's own `anim.sound` names an sfx registry key, not a file -- the same
 * indirection a cry has, just through a different registry (Sound.playMove
 * reads `data.audio.sfx[anim.sound]`). So an imported recording needs a
 * matching sfx:register() of its own, which is what this collects; the move
 * record itself already points at it (stepMoveSound sets anim.sound to the
 * invented key on import).
 */
function moveSoundEffectRecords() {
  return allMoves()
    .filter((m) => m._soundImport?.b64)
    .map((m) => ({ id: m._soundImport.key, data: { file: moveSoundFile(m) } }));
}

function moveSoundAudioFiles() {
  return allMoves()
    .filter((m) => m._soundImport?.b64)
    .map((m) => ({ name: moveSoundFile(m), bytes: base64Bytes(m._soundImport.b64) }));
}

/**
 * The position and timing a freeform move actually plays with, resolved for
 * export -- pulled straight from the base coordinate step 5's preview
 * pointed at, so the numbers that ship are exactly the ones that were
 * clicked, not re-derived from anything that could drift.
 */
function freeformAnimData(m) {
  const a = m._anim;
  const coord = animLib()?.baseCoords?.[a.coord ?? 0] || { x: 84, y: 60 };
  return {
    image: moveSheetFile(m),
    frameW: a.strip.frameW, frameH: a.strip.frameH, frames: a.strip.frames,
    x: coord.x, y: coord.y, rate: Math.max(1, a.rate || 4), mirror: a.mirror !== false,
  };
}

/**
 * The runtime helper a freeform animation needs, and why it has to be Lua
 * Oak's Lab writes rather than a content record.
 *
 * `battle_anims` has exactly three write routes -- a move's own animation, a
 * subanim, a tile sheet -- and none of them is "a new arrangement of tiles".
 * frameBlocks and baseCoords (the tables that would define one) have no
 * registry route at all; only the game's own 122/177 exist. So a freeform
 * strip cannot become a content record no matter how it is shaped, and has
 * to be drawn by code instead.
 *
 * That code is two hooks, both part of the documented mod surface (not an
 * internal module reached around it): `battle.move_used` fires the instant
 * a move starts and is where playback begins and the turn is held open
 * (`battle:waitNext`, the same call the engine's own status effects use for
 * exactly this); `battle.overlay` fires once a frame, after the whole
 * battle screen has finished compositing, and is where the current cell of
 * the strip actually gets drawn.
 *
 * Defined as locals ABOVE `return function(mod)` rather than inside it, so
 * every move's hook closes over the same one copy regardless of how many
 * moves use this -- the table is the only thing that grows per move.
 *
 * Colour: whatever was painted plays exactly as painted, in every display
 * mode. This is a structural fact of drawing outside the game's own picture
 * pipeline, not an oversight -- see the warning on step 5. Painting in the
 * four Game Boy greys is what keeps it looking native everywhere.
 */
function freeformRuntimePreamble() {
  const moves = freeformMoves();
  if (!moves.length) return "";
  const rows = moves.map((m) => {
    const d = freeformAnimData(m);
    const id = m.id || idFromName(m.data.name);
    return `  ${luaKey(id)} = { image = ${luaStr(d.image)}, frameW = ${d.frameW}, frameH = ${d.frameH}, `
      + `frames = ${d.frames}, x = ${d.x}, y = ${d.y}, rate = ${d.rate}, mirror = ${d.mirror} },`;
  });
  return [
    "-- Oak's Lab: plays a hand-painted move animation. There is no content-",
    "-- record route for a new tile arrangement (only for borrowing the",
    "-- game's own), so this is code rather than data -- battle.move_used",
    "-- starts it and holds the turn open; battle.overlay draws it, once a",
    "-- frame, after the whole battle screen has composited.",
    "local OaksLabFreeformAnims = {",
    ...rows,
    "}",
    "local oaksLabFreeformImages, oaksLabFreeformPlaying = {}, nil",
    "local function oaksLabFreeformImage(path)",
    "  local img = oaksLabFreeformImages[path]",
    "  if img == nil then",
    "    local ok, result = pcall(love.graphics.newImage, path)",
    "    img = ok and result or false",
    "    oaksLabFreeformImages[path] = img",
    "  end",
    "  if img == false then return nil end",
    "  return img",
    "end",
  ].join("\n");
}

// Wired inside `return function(mod)`, once, only when a freeform move
// exists -- registered against the shared locals the preamble above defines.
function freeformRuntimeHooks() {
  if (!freeformMoves().length) return [];
  return [
    `  mod.events:on("battle.move_used", function(e)`,
    `    local def = OaksLabFreeformAnims[e.move.id]`,
    `    if not def then return end`,
    `    oaksLabFreeformPlaying = { def = def, frame = 0, isPlayer = e.user.isPlayer }`,
    `    e.battle:waitNext(def.frames * def.rate)`,
    `  end)`,
    ``,
    `  mod.hooks:wrap("battle.overlay", function(nextFn, battle)`,
    `    nextFn()`,
    `    local p = oaksLabFreeformPlaying`,
    `    if not p then return end`,
    `    local def = p.def`,
    `    local img = oaksLabFreeformImage(def.image)`,
    `    if img then`,
    `      local cell = math.min(def.frames - 1, math.floor(p.frame / def.rate))`,
    `      local quad = love.graphics.newQuad(0, cell * def.frameH, def.frameW, def.frameH,`,
    `                                          img:getWidth(), img:getHeight())`,
    `      -- mirror: HFLIP's own rule (168 - x), for a move used from the`,
    `      -- other side of the screen from the one it was placed on`,
    `      local flip = def.mirror and not p.isPlayer`,
    `      local originX = flip and (168 - def.x) or def.x`,
    `      local x = originX - 8 - def.frameW / 2`,
    `      local y = def.y - 16 - def.frameH`,
    `      love.graphics.setColor(1, 1, 1, 1)`,
    `      if flip then`,
    `        love.graphics.draw(img, quad, x + def.frameW, y, 0, -1, 1)`,
    `      else`,
    `        love.graphics.draw(img, quad, x, y, 0, 1, 1)`,
    `      end`,
    `    end`,
    `    p.frame = p.frame + 1`,
    `    if p.frame >= def.frames * def.rate then oaksLabFreeformPlaying = nil end`,
    `  end)`,
  ];
}

/* ------------------------------------------------------------- the tab -- */

function moveStep(host, n, title, note) {
  const wrap = el("div", { class: "step" });
  wrap.append(el("h3", {},
    el("span", { class: "n" }, n === null ? "—" : n + "."),
    title,
    note ? el("span", { class: "said" }, note) : null));
  const body = el("div", { class: "body" });
  wrap.append(body);
  host.append(wrap);
  return body;
}

function renderMoveTab() {
  const host = $("#moveSteps");
  if (!host) return;
  stopCry();
  host.textContent = "";

  const m = curMove();
  $("#moveTitle").innerHTML = m
    ? "Move <b>" + escapeText(moveName(m)) + "</b>" + (isMoveDraft(m) ? " — not added yet" : "")
    : "Moves";

  moveBar(host, m);
  if (!m) {
    host.append(el("div", { class: "step" },
      el("div", { class: "empty" },
        allMoves().length
          ? "Pick one from the list above, or press New."
          : "No moves in this mod yet. Press New to invent one, or Copy to start from one of the game's own.")));
    return;
  }

  syncMoveEffect(m);
  stepMoveName(host, m);
  stepMoveType(host, m);
  stepMoveNumbers(host, m);
  stepMoveEffect(host, m);
  stepMoveAnim(host, m);
  stepMoveSound(host, m);
  stepMoveWho(host, m);
}

function guardMoveDraft(proceed) {
  guardDraftReplace(P.moveDraft,
    { label: "“" + moveName(P.moveDraft) + "”", why: P.moveDraft && moveDraftBlocker(P.moveDraft), add: () => addMoveDraft(P.moveDraft) },
    proceed);
}

function moveBar(host, cur) {
  const bar = el("div", { class: "workbar" });
  bar.append(el("button", { class: "fixed", onclick: () => guardMoveDraft(copyMoveDialog) }, "Copy"));
  bar.append(el("button", {
    class: "fixed",
    onclick: () => guardMoveDraft(() => { P.moveDraft = blankMove(); P.sel.move = "draft"; touch(); renderMoveTab(); }),
  }, "New"));

  const rows = allMoves();
  if (rows.length || P.moveDraft) {
    bar.append(el("select", {
      onchange: (e) => { P.sel.move = e.target.value || null; renderMoveTab(); },
    },
      el("option", { value: "" }, `— ${rows.length} in this mod —`),
      P.moveDraft ? el("option", { value: "draft", selected: cur === P.moveDraft },
        (moveName(P.moveDraft) === "(unnamed)" ? "new move" : moveName(P.moveDraft)) + "  (not added yet)") : null,
      ...rows.map((r) => el("option", { value: r._uid, selected: r === cur }, moveName(r)))));
  }

  if (isMoveDraft(cur)) {
    const why = moveDraftBlocker(cur);
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", {
      id: "moveAddDraft", class: "primary fixed", disabled: !!why, title: why || "",
      onclick: () => addMoveDraft(cur),
    }, "Add to the mod"));
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => discardMoveDraft() }, "Discard"));
  } else if (cur) {
    // Delete used to live in a closing "That's it" step. That step is gone,
    // so it moves up here rather than disappearing with it -- Discard sits in
    // the same place for a draft, which is the same gesture on the same row.
    bar.append(el("div", { style: "flex:1" }));
    // Same spot "Add to the mod" sat in before it was added -- a quiet pulse
    // once editing pauses (flashUpdated, driven by touch()'s own debounce),
    // not a button, since edits already apply live and autosave as they're
    // made and there is nothing here to actually commit.
    bar.append(el("span", { id: "moveUpdated", class: "updated-flash" }, "Updated"));
    bar.append(el("button", { class: "fixed", onclick: () => showTab("script") }, "See the Lua"));
    bar.append(el("button", { class: "fixed danger", onclick: () => deleteMove(cur) }, "Delete this move"));
  }
  host.append(bar);
}

const moveDraftBlocker = (m) => !m.data.name ? "Give it a name first." : null;

/**
 * Add the draft, and honour whatever asked for it.
 *
 * A move started from a Pokemon's move list carries `_wantedBy` -- who asked
 * and for which slot. Filling that in here is the whole point of the button
 * over there: "invent a move" should end with the Pokemon knowing it, not
 * with the user having to go back and pick it out of a 166-long dropdown.
 */
function addMoveDraft(m) {
  const want = m._wantedBy;
  delete m._wantedBy;
  m.id = m.id || idFromName(m.data.name);
  m.data.id = m.id;
  P.entries.push(m);
  P.moveDraft = null;
  P.sel.move = m._uid;

  let backTo = null;
  if (want) backTo = giveMoveToMon(m, want);
  touch(); renderAll();
  if (backTo) {
    P.sel.mon = backTo;
    showContentSub("pokemon");
    toast(moveName(m) + " added, and given to that Pokemon");
  } else {
    showContentSub("moves");
    toast(moveName(m) + " added");
  }
}

// Put a finished move into the species that asked for it, in the slot it
// asked for. Returns the species' uid so the caller can go back to it.
function giveMoveToMon(m, want) {
  const target = want.uid === "draft" ? P.monDraft
    : P.entries.find((e) => e.registry === "pokemon" && e._uid === want.uid);
  if (!target) return null;
  if (want.slot === "start") {
    const list = target.data.level1Moves || (target.data.level1Moves = []);
    // Four is the hard limit -- a Pokemon has four move slots and the engine
    // reads the first four. Overwriting the last one is the least surprising
    // thing to do with a full list, but it is a loss, so it says so.
    if (list.length < 4) {
      list.push(m.id);
    } else {
      const lost = list[3];
      list[3] = m.id;
      toast(`Starting moves were full — replaced ${lost || "the fourth slot"}`, true);
    }
  } else if (want.slot === "learn") {
    const list = target.data.learnset || (target.data.learnset = []);
    list.push({ level: want.level || 10, move: m.id });
  } else {
    const list = target.data.tmhm || (target.data.tmhm = []);
    if (!list.includes(m.id)) list.push(m.id);
  }
  return want.uid === "draft" ? "draft" : target._uid;
}

function discardMoveDraft() {
  if (!confirm("Throw this one away?")) return;
  P.moveDraft = null; P.sel.move = null;
  touch(); renderMoveTab();
}

function deleteMove(m) {
  if (!confirm(`Delete ${moveName(m)}?`)) return;
  P.entries = P.entries.filter((e) => e !== m);
  P.sel.move = null;
  touch(); renderAll();
}

/* --------------------------------------------------------------- 1. name -- */

function stepMoveName(host, m) {
  const patching = m.verb === "patch";
  const body = moveStep(host, 1, "Name", patching ? "changing the game's " + m.id : (m.id || null));

  if (patching) {
    body.append(el("p", { class: "hint warn" },
      `This one is not a new move — it patches the game's ${m.id}, so everything here changes `
      + "that move rather than adding one beside it. Anything you leave alone stays as the game "
      + "has it."));
  }

  body.append(el("label", {}, "What is it called?"));
  const idLine = el("div", { class: "hint" });
  const showId = () => {
    idLine.textContent = patching
      ? `Kept under the id ${m.id}, which is what makes it the same move.`
      : m.id ? `The engine will know it as ${m.id}, move number ${m.data.index}.` : "";
  };
  body.append(el("input", {
    value: m.data.name || "", placeholder: "Ember Burst", maxlength: "24",
    oninput: (e) => {
      const was = m.id;
      m.data.name = e.target.value.toUpperCase();
      if (!patching) {
        m.id = idFromName(m.data.name);
        m.data.id = m.id;
        if (was && was !== m.id) renameMoveRefs(was, m.id);
      }
      showId();
      const t = $("#moveTitle");
      if (t) t.innerHTML = "Move <b>" + escapeText(moveName(m)) + "</b>" + (isMoveDraft(m) ? " — not added yet" : "");
      touch(); syncMoveDraftReady(m);
    },
  }));
  showId();
  body.append(idLine);
  body.append(el("p", { class: "hint" },
    "Gen 1 draws move names in capitals in a twelve-character box, so anything much longer than "
    + "THUNDERBOLT gets cut off on the battle screen."));

  if (isMoveDraft(m)) {
    const why = moveDraftBlocker(m);
    body.append(el("p", { id: "moveDraftWhy", class: "hint" + (why ? " warn" : "") },
      why ? why + " Until then “Add to the mod” at the top of this tab stays greyed out."
          : "Ready — press “Add to the mod” at the top of this tab."));
    if (m._wantedBy) {
      body.append(el("p", { class: "hint" },
        "Adding it will also hand it straight to the Pokemon you started it from."));
    }
  }
}

function syncMoveDraftReady(m) {
  if (!isMoveDraft(m)) return;
  const why = moveDraftBlocker(m);
  const b = $("#moveAddDraft");
  if (b) { b.disabled = !!why; b.title = why || ""; }
  const p = $("#moveDraftWhy");
  if (p) {
    p.className = "hint" + (why ? " warn" : "");
    p.textContent = why ? why + " Until then “Add to the mod” at the top of this tab stays greyed out."
      : "Ready — press “Add to the mod” at the top of this tab.";
  }
}

// Renaming a move that Pokemon in this mod already know has to follow it
// through their lists, or they quietly end up pointing at nothing.
function renameMoveRefs(from, to) {
  for (const e of [...P.entries, P.monDraft].filter(Boolean)) {
    if (e.registry !== "pokemon") continue;
    const d = e.data || {};
    if (Array.isArray(d.level1Moves)) d.level1Moves = d.level1Moves.map((x) => (x === from ? to : x));
    if (Array.isArray(d.learnset)) for (const r of d.learnset) if (r.move === from) r.move = to;
    if (Array.isArray(d.tmhm)) d.tmhm = d.tmhm.map((x) => (x === from ? to : x));
  }
}

/* ---------------------------------------------------------- 2. type/kind -- */

function stepMoveType(host, m) {
  const type = m.data.type || "NORMAL";
  const auto = MOVE_TYPE_CATEGORY[type];
  const effective = m.data.category || auto || "physical";
  const body = moveStep(host, 2, "Type", `${type.replace("_TYPE", "")} · ${effective}`);

  body.append(el("label", {}, "Type"));
  body.append(refSelect("type_chart", () => m.data.type || "",
    (v) => { m.data.type = v || "NORMAL"; touch(); renderMoveTab(); }, { noFilter: true }));

  body.append(el("p", { class: "hint" },
    "Type is doing two jobs here. It decides what the move is strong and weak against — and in "
    + "Gen 1 it also decides which stat the damage comes off. There is no per-move choice: the "
    + "first eight types are physical and the rest are special, full stop."));

  const same = Object.entries(MOVE_TYPE_CATEGORY).filter(([, c]) => c === auto).map(([t]) => t.replace("_TYPE", ""));
  if (auto) {
    body.append(el("p", { class: "hint" },
      `${type.replace("_TYPE", "")} is ${auto}, along with ${same.filter((t) => t !== type.replace("_TYPE", "")).join(", ")}.`));
  }

  const override = !!m.data.category;
  body.append(el("label", { style: "margin-top:10px" },
    el("input", {
      type: "checkbox", checked: override,
      onchange: (e) => {
        if (e.target.checked) m.data.category = auto || "physical";
        else delete m.data.category;
        touch(); renderMoveTab();
      },
    }),
    "Override that and pick the stat myself"));
  if (override) {
    body.append(el("select", {
      onchange: (e) => { m.data.category = e.target.value; touch(); renderMoveTab(); },
    }, ...["physical", "special", "status"].map((c) =>
      el("option", { value: c, selected: m.data.category === c }, c))));
    body.append(el("p", { class: "hint warn" },
      "This is a field the engine honours but the original game never used — a special Normal "
      + "move is something Gen 1 has no example of. Fine, and worth knowing it is your invention "
      + "rather than something the player has seen before."));
  }
}

/* ---------------------------------------------------------- 3. the numbers -- */

function stepMoveNumbers(host, m) {
  const power = Number(m.data.power) || 0;
  const body = moveStep(host, 3, "Power, accuracy and PP",
    (power ? power + " power" : "no damage") + ` · ${m.data.accuracy}% · ${m.data.pp} PP`);

  const rows = vanillaMoveRows();
  const cohort = power > 0 ? rows.damaging : rows.status;
  const cohortName = power > 0 ? "damaging moves" : "moves that do no damage";

  if (!rows.all.length) {
    body.append(el("p", { class: "hint warn" },
      "Load game data to see how these compare with the game's own moves."));
  } else {
    body.append(el("p", { class: "hint" },
      `Measured against the ${cohort.length} of the game's ${cohortName} — which is what this one `
      + "is, going by its power. The shaded part of each bar is where most of them sit; the notch "
      + "is the middle one."));
  }

  const numberRow = (label, key, min, max, hintText) => {
    const band = rows.all.length ? moveBand(cohort, key) : null;
    const row = el("div", { class: "statrow" });
    row.append(el("span", { class: "statname" }, label));
    const input = el("input", {
      type: "number", min: String(min), max: String(max), value: String(m.data[key] ?? 0), class: "statnum",
      oninput: (e) => {
        m.data[key] = Math.max(min, Math.min(max, Number(e.target.value) || 0));
        touch(); renderMoveTab();
      },
    });
    row.append(input);
    if (band) {
      let verdictSpan = null;
      const setLive = (v) => {
        m.data[key] = Math.max(min, Math.min(max, v));
        input.value = String(m.data[key]);
        if (verdictSpan) {
          const vv = verdictOf(percentileIn(band.sorted, m.data[key] || 0));
          verdictSpan.textContent = vv.word;
          verdictSpan.className = "statword " + vv.cls;
        }
        touch();
      };
      row.append(statBar(band, m.data[key] || 0, null, { onChange: setLive, onCommit: renderMoveTab }));
      const v = verdictOf(percentileIn(band.sorted, m.data[key] || 0));
      verdictSpan = el("span", { class: "statword " + v.cls }, v.word);
      row.append(verdictSpan);
    }
    body.append(row);
    if (hintText) body.append(el("p", { class: "hint", style: "margin:0 0 10px 70px" }, hintText));
    return band;
  };

  const powerBand = numberRow("Power", "power", 0, 255,
    "Zero means it does no damage at all — that is what makes something a status move.");
  numberRow("Accuracy", "accuracy", 0, 100,
    "Out of 100, but Gen 1 has a rounding bug that costs every move about 0.4% on top: a "
    + "100%-accurate move still misses roughly one time in 256.");
  numberRow("PP", "pp", 0, 64,
    "How many times it can be used before a Pokemon Center. A Potion-cheap 35 is Tackle; 5 is "
    + "the sort of number reserved for the game's biggest hits.");

  if (powerBand && power > 0) {
    const pct = percentileIn(powerBand.sorted, power);
    const v = verdictOf(pct);
    body.append(el("p", { class: "hint " + (v.cls === "good" ? "" : v.cls) },
      `${power} power is ${v.word} for a damaging move, ${percentileText(pct)}. `
      + `Nearest: ${nearestMoves(rows.damaging, "power", power).join(", ")}.`));
    if (power > powerBand.max) {
      body.append(el("p", { class: "hint bad" },
        `Nothing in the game hits for ${power}; the hardest is ${powerBand.max}. Fine if you meant `
        + "it, but there is no counterplay in the game for something this size."));
    }
  }

  /* --- the flags that are one tick each --- */
  body.append(el("h2", { style: "margin-top:16px" }, "The extras"));
  const flag = (label, key, hintText) => {
    body.append(el("label", { style: "margin-top:6px" },
      el("input", {
        type: "checkbox", checked: !!m.data[key],
        onchange: (e) => {
          if (e.target.checked) m.data[key] = true; else delete m.data[key];
          touch(); renderMoveTab();
        },
      }), label));
    body.append(el("div", { class: "hint" }, hintText));
  };
  flag("Lands critical hits more often", "highCrit",
    "Gen 1 crits scale off Speed, and a high-crit move multiplies that chance by eight — on a fast "
    + "Pokemon that is most hits, not a lucky few. This is what Slash and Razor Leaf carry.");

  body.append(el("label", { style: "margin-top:10px" }, "Goes before or after other moves"));
  body.append(el("input", {
    type: "number", min: "-7", max: "7", value: String(m.data.priority || 0),
    oninput: (e) => {
      const v = Math.max(-7, Math.min(7, Number(e.target.value) || 0));
      if (v) m.data.priority = v; else delete m.data.priority;
      touch();
    },
  }));
  body.append(el("div", { class: "hint" },
    "0 is normal — Speed decides. 1 is Quick Attack, always first. -1 is Counter, always last."));
}

/* ------------------------------------------------------------ 4. effects -- */

function stepMoveEffect(host, m) {
  const fx = m._fx || (m._fx = { mode: "none" });
  const chosen = effectFor(m);
  const body = moveStep(host, 4, "Move Effects", effectSummary(m, chosen));

  body.append(el("p", { class: "hint" },
    "Gen 1 has no “25% chance to burn” field. It has sixty-eight named effects, and the odds live "
    + "inside each one — so this asks the question the other way round and finds the effect that "
    + "means it, or writes one."));

  body.append(el("label", {}, "Besides damage, it…"));
  body.append(el("select", {
    onchange: (e) => { fx.mode = e.target.value; syncMoveEffect(m); touch(); renderMoveTab(); },
  },
    el("option", { value: "none", selected: fx.mode === "none" }, "Nothing"),
    el("option", { value: "status", selected: fx.mode === "status" }, "Status Effect"),
    el("option", { value: "preset", selected: fx.mode === "preset" }, "Other Move Effect")));

  if (fx.mode === "status") {
    stepMoveStatus(body, m, fx, chosen);
  } else if (fx.mode === "preset") {
    body.append(el("label", { style: "margin-top:10px" }, "Which one"));
    const sel = el("select", {
      onchange: (e) => { fx.preset = e.target.value; syncMoveEffect(m); touch(); renderMoveTab(); },
    });
    const ids = (allIds("move_effects") || []).map((o) => o.id).sort((a, b) =>
      effectLabel(a).localeCompare(effectLabel(b)));
    for (const id of ids) {
      sel.append(el("option", { value: id, selected: (fx.preset || m.data.effect) === id },
        effectLabel(id) + "  —  " + id));
    }
    body.append(sel);
    body.append(el("p", { class: "hint" },
      "These are the engine's own effects, exactly as the game's moves use them. Picking one costs "
      + "nothing and behaves the way the player already expects it to."));
    if ((fx.preset || m.data.effect) === "SPECIAL_DAMAGE_EFFECT") fixedDamageBlock(body, m);
  } else {
    body.append(el("p", { class: "hint" },
      "A plain attack. Most of the game's moves are this, and it is the right answer far more "
      + "often than it looks."));
  }

  body.append(el("p", { class: "hint", style: "margin-top:12px" },
    "Exports as ", el("code", {}, `effect = "${chosen.id}"`), "."));
}

/**
 * How much a fixed-damage move does.
 *
 * The trap this closes: the game's own Sonicboom carries no number. The
 * engine keeps a table of five move IDS with their amounts and falls back to
 * it, so a copy under a new name inherits the effect and nothing to deal --
 * and would hit for nothing at all, silently. Anything that picks this effect
 * gets an amount written now rather than discovering that in a battle.
 *
 * The two level-scaled forms are Lua functions rather than magic strings,
 * because a function is what the field's own schema accepts beside a number.
 */
const FIXED_DAMAGE_FORMS = [
  ["flat", "a flat number"],
  ["level", "the user's level — what Seismic Toss does"],
  ["psywave", "half the user's level to one and a half times it — Psywave's roll"],
];
const LEVEL_DAMAGE = "@lua:function(ctx) return ctx.user.mon.level end";
const PSYWAVE_DAMAGE = "@lua:function(ctx)\n"
  + "      return ctx.rng(1, math.max(1, math.floor(ctx.user.mon.level * 3 / 2) - 1))\n"
  + "    end";

const fixedDamageForm = (v) =>
  v === LEVEL_DAMAGE ? "level" : v === PSYWAVE_DAMAGE ? "psywave" : "flat";

// The engine's own fallback table (MoveEffects.FIXED_DAMAGE), which is what
// the game's five fixed-damage moves rely on instead of carrying a field. Only
// read when copying one of them, to write the number down.
const ENGINE_FIXED_DAMAGE = {
  SONICBOOM: 20, DRAGON_RAGE: 40,
  SEISMIC_TOSS: LEVEL_DAMAGE, NIGHT_SHADE: LEVEL_DAMAGE, PSYWAVE: PSYWAVE_DAMAGE,
};

function fixedDamageBlock(body, m) {
  if (m.data.fixedDamage === undefined) { m.data.fixedDamage = 20; touch(); }
  const form = fixedDamageForm(m.data.fixedDamage);

  body.append(el("label", { style: "margin-top:10px" }, "How much damage"));
  body.append(el("select", {
    onchange: (e) => {
      m.data.fixedDamage = e.target.value === "level" ? LEVEL_DAMAGE
        : e.target.value === "psywave" ? PSYWAVE_DAMAGE : 20;
      touch(); renderMoveTab();
    },
  }, ...FIXED_DAMAGE_FORMS.map(([id, label]) =>
    el("option", { value: id, selected: form === id }, label))));

  if (form === "flat") {
    body.append(el("input", {
      type: "number", min: "1", max: "255", value: String(m.data.fixedDamage || 20),
      oninput: (e) => { m.data.fixedDamage = Math.max(1, Math.min(255, Number(e.target.value) || 1)); touch(); },
    }));
    body.append(el("div", { class: "hint" },
      "Ignores every stat on both sides, and type effectiveness with them — Sonicboom is 20, "
      + "Dragon Rage is 40. Twenty flat damage is enormous at level 5 and nothing at level 50, "
      + "which is what makes these early-game moves."));
  } else {
    body.append(el("div", { class: "hint" },
      "Exported as a small Lua function, because that is the other thing this field takes. It "
      + "keeps up with the player instead of falling behind them."));
  }
}

function stepMoveStatus(body, m, fx, chosen) {
  fx.status = fx.status || "PAR";
  fx.chance = fx.chance ?? 10;
  const row = statusRow(fx.status);

  body.append(el("label", { style: "margin-top:10px" }, "Which condition"));
  body.append(el("select", {
    onchange: (e) => { fx.status = e.target.value; syncMoveEffect(m); touch(); renderMoveTab(); },
  }, ...MOVE_STATUSES.map((s) =>
    el("option", { value: s.id, selected: fx.status === s.id }, s.label))));
  if (row) body.append(el("div", { class: "hint" }, row.note));

  body.append(el("label", { style: "margin-top:10px" }, "How often"));
  const out = el("span", { class: "statword" }, fx.chance + "%");
  body.append(el("div", { class: "row" },
    el("input", {
      type: "range", min: "1", max: "100", value: String(fx.chance),
      oninput: (e) => {
        fx.chance = Number(e.target.value);
        out.textContent = fx.chance + "%";
        syncMoveEffect(m);
        touch();
        renderMoveTab();
      },
    }), out));

  // What the game itself offers for this condition, as buttons -- landing on
  // one is worth doing on purpose, because it is the difference between a mod
  // that ships Lua and one that does not.
  const offered = [
    ...(VANILLA_SIDE_EFFECTS[fx.status] || []).map(([n]) => chancePct(n)),
    ...(ALWAYS_EFFECTS[fx.status] ? [100] : []),
  ];
  if (offered.length) {
    const pills = el("div", { class: "row", style: "flex-wrap:wrap;margin-top:6px" });
    for (const p of offered) {
      pills.append(el("button", {
        class: "fixed" + (fx.chance === p ? " primary" : ""),
        onclick: () => { fx.chance = p; syncMoveEffect(m); touch(); renderMoveTab(); },
      }, p === 100 ? "always" : p + "%"));
    }
    body.append(el("div", { class: "hint", style: "margin-bottom:0" }, "The game already has:"));
    body.append(pills);
  }

  if (chosen.custom) {
    body.append(el("p", { class: "hint warn", style: "margin-top:10px" },
      `Nothing in the game means "${fx.chance}% ${row?.label.toLowerCase() || fx.status}", so Oak's Lab `
      + "will write it — a few lines of Lua in your main.lua, registered as ",
      el("code", {}, chosen.id),
      ". It is readable, and it is the same shape as the engine's own, so it is worth opening on "
      + "the Scripts tab and reading once."));
  } else {
    const users = Object.values(GAME?.moves || {}).filter((r) => r.effect === chosen.id)
      .map((r) => r.name || r.id).slice(0, 4);
    body.append(el("p", { class: "hint good", style: "margin-top:10px" },
      "The game already has exactly this: ", el("code", {}, chosen.id),
      users.length ? ` — the same one ${users.join(", ")} use${users.length > 1 ? "" : "s"}. ` : ". ",
      "Your mod ships no code at all for it."));
  }

  if (fx.status === "SLP" && fx.chance < 100) {
    body.append(el("p", { class: "hint warn" },
      "Gen 1 has no “chance to sleep” at all — sleep is only ever a move's whole point, never a "
      + "side effect, and there is no way to roll for it that the engine will honour. This will "
      + "export as an always-sleeps move; give it no power to make it a proper status move."));
  }

  if (Number(m.data.power) > 0 && !["CONFUSION", "FLINCH"].includes(fx.status)) {
    body.append(el("p", { class: "hint" },
      "One rule that catches people out: a side effect never lands when the move's TYPE matches "
      + "one of the target's types. A Fire move cannot burn a Fire-type, an Electric one cannot "
      + "paralyse an Electric-type — at any chance, including 100%. Poison is the exception."));
  }
  if (Number(m.data.power) === 0 && fx.chance < 100) {
    body.append(el("p", { class: "hint warn" },
      "A move with no power never gets to its side effect — the engine only rolls those after "
      + "damage. Give it some power, or set this to always."));
  }
}

/* ---------------------------------------------------------- 5. animation -- */

function stepMoveAnim(host, m) {
  const a = m._anim || (m._anim = { source: "game", id: "" });
  const lib = animLib();
  const note = a.source === "freeform"
    ? (a.strip ? plural(a.strip.frames, "frame") + ", yours" : "nothing painted yet")
    : a.id ? "borrowed from " + a.id : "nothing yet";
  const body = moveStep(host, 5, "What it looks like", note);

  body.append(el("p", { class: "hint" },
    "The flash across the battle screen. Borrow one of the game's animations wholesale, or paint "
    + "your own — a strip of frames that plays in order, at a spot you pick by tapping the screen."));

  if (!lib) {
    body.append(el("p", { class: "hint warn" },
      "This copy of Oak's Lab was built without game data, which is where the animations and the "
      + "177 places one can happen live. Regenerate it locally to pick or preview one."));
    return;
  }

  body.append(el("label", {}, "Where it comes from"));
  body.append(el("select", {
    onchange: (e) => { a.source = e.target.value; touch(); renderMoveTab(); },
  },
    el("option", { value: "game", selected: a.source !== "freeform" }, "one the game already has"),
    el("option", { value: "freeform", selected: a.source === "freeform" }, "one I paint myself")));

  if (a.source !== "freeform") {
    body.append(el("label", { style: "margin-top:10px" }, "Borrow which one"));
    body.append(refSelect("battle_anims", () => a.id || "",
      (v) => { a.id = v; touch(); renderMoveTab(); },
      { blank: "— none (nothing on screen) —" }));
    if (!a.id) {
      body.append(el("p", { class: "hint warn" },
        "With nothing here the move does its damage in silence and with an empty screen — the "
        + "engine has no fallback animation to fall back on."));
      return;
    }
    body.append(el("p", { class: "hint" },
      "The rows get copied under your move's own id, because the engine looks an animation up by "
      + "the move's name and never by anything else."));
    animPreviewBlock(body, m);
    body.append(el("div", { class: "row", style: "margin-top:8px" },
      el("button", { class: "fixed", onclick: () => exportAnimStripDialog(m) }, "Export the game's art"),
      el("span", { class: "hint" },
        "Frame by frame, as a strip — the start of painting your own version of it.")));
  } else {
    freeformAnimEditor(body, m, a);
  }
}

/**
 * The preview, with its own Play button and the screen effects listed under it.
 *
 * The effects are listed rather than drawn because most of them belong to the
 * battle screen this preview does not have -- there is no Pokemon here to
 * slide off or blink. Naming them in order is honest about what will also
 * happen; pretending otherwise would make the preview a worse guide than no
 * preview at all.
 */
// The message-box text the preview shows -- decorative, not exported, just
// enough for the mock screen to read as a real one instead of an empty box.
const previewMessage = (m) => (moveName(m) || "MOVE").toUpperCase() + " USED!";

function animPreviewBlock(body, m) {
  const resolved = moveAnimFor(m);
  if (!resolved) {
    body.append(el("p", { class: "hint warn" }, "Nothing to preview yet."));
    return;
  }
  const soundDef = moveSoundDef(m.data.anim);
  const preview = animPreview(resolved, {
    scale: 2, message: previewMessage(m),
    onPlaySound: soundDef && sfxPlayable() ? () => playCry(soundDef) : null,
  });
  body.append(preview.el);
  body.append(el("div", { class: "row", style: "margin-top:6px" },
    el("button", { class: "primary fixed", onclick: () => preview.play() }, "▶ Play it"),
    el("span", { class: "hint" },
      soundDef ? "Picture and sound together, at the speed the game runs it."
        : "No sound picked yet — step 6.")));

  const fx = preview.compiled?.effects || [];
  if (fx.length) {
    body.append(el("p", { class: "hint" },
      "It also does this to the battle screen, in order: "
      + fx.map((e) => seLabel(e.effect)).join(", ")
      + ". Those move the Pokemon and the screen itself, which this little preview has neither of."));
  }
  const total = preview.compiled?.frames || 0;
  if (total) {
    body.append(el("p", { class: "hint" },
      `${total} frames — about ${(total / 60).toFixed(1)} seconds. `
      + (total > 180 ? "That is a long one; it plays every single time the move is used." : "")));
  }

  // Which of the 177 positions this one draws at, for typing the same
  // number into a freeform effect meant to sit in the same place.
  const coords = vanillaAnimCoords(resolved.seq, resolved.lib);
  if (coords.length) {
    body.append(el("p", { class: "hint" },
      `Draws at position ${coords.join(", ")} — type ${coords.length > 1 ? "one of those" : "that"} `
      + "into a freeform effect's Position field for the same spot."));
  }

  // How its own pictures are paced, which is the number to match when
  // painting a replacement -- the strip carries its frames but not their
  // timing, so this is where that comes from.
  const held = (preview.compiled?.steps || []).filter((s) => s.sprites.length).map((s) => s.dur);
  if (held.length) {
    const uniform = held.every((d) => d === held[0]);
    body.append(el("p", { class: "hint" },
      uniform
        ? `Its pictures change every ${held[0]} game-frame${held[0] === 1 ? "" : "s"} — that is the `
          + "speed to match if you paint your own version of it."
        : `Its pictures are held for ${Math.min(...held)}–${Math.max(...held)} game-frames, so it does `
          + "not run at one steady speed; a painted version uses a single speed for all of them."));
  }
}

/* --- painting one by hand --- */

/**
 * Step 5's freeform path: a strip of your own frames, played in order, at a
 * spot you choose by tapping the screen -- no shape lookup, no scattered
 * tile indices, none of the frame-block/base-coord bookkeeping the "borrow
 * one of the game's" path has to reckon with.
 *
 * This does not go through battle_anims at all: there is no route to
 * register a new frame-block arrangement (only a move's own animation, a
 * subanim, or a tile sheet can be registered), so a hand-drawn strip cannot
 * live there regardless. Instead it exports as a small shared Lua helper
 * (see core.js's freeform preamble) that plays the strip on the
 * `battle.move_used` / `battle.overlay` hooks, holding the turn open for it
 * exactly as the vanilla animation would.
 */
function freeformAnimEditor(body, m, a) {
  a.coord = a.coord ?? 0;
  a.rate = a.rate || 4;
  a.mirror = a.mirror !== false;
  const lib = animLib();

  body.append(el("div", { class: "who", style: "margin-top:12px" }, "Where it happens"));
  body.append(el("p", { class: "hint" },
    "Tap the preview below to move it, or type the number directly — the same 177 spots the game's "
    + "own animations use, so it still lands somewhere that reads as part of a battle rather than "
    + "anywhere at all. Borrowing one of the game's animations elsewhere on this move (or exporting "
    + "its art) says which number it draws at, if you want this to land in the same spot."));

  const maxCoord = Math.max(0, Object.keys(lib?.baseCoords || {}).length - 1);

  body.append(el("div", { class: "who", style: "margin-top:14px" }, "The picture"));
  body.append(el("p", { class: "hint" },
    "A strip of frames, top to bottom — paint anything, any size. It plays frame 1 through the "
    + "last, once, in order, like a short film rather than a shape built out of the game's own "
    + "pieces."));

  const stripRow = el("div", { class: "row", style: "flex-wrap:wrap" });
  stripRow.append(el("button", {
    class: "fixed",
    onclick: () => spriteStudio({
      title: "Paint a move's animation",
      mode: "filmstrip",
      fileBase: (m.id || "move").toLowerCase() + "_anim",
      hint: "Any number of frames, any size. Nothing is picked for you — tap the shapes it finds in "
        + "the order they should play.",
      onDone: (art) => { a.strip = art; touch(); renderMoveTab(); },
    }),
  }, a.strip ? "Re-paint" : "Paint the strip"));
  stripRow.append(el("button", { class: "fixed", onclick: () => exportAnimStripDialog(m) },
    "Export the game's art"));
  if (a.strip) {
    stripRow.append(el("button", {
      class: "fixed",
      onclick: () => exportArt({ png: a.strip.png }, (m.id || "move").toLowerCase() + "_anim"),
    }, "Export mine"));
  }
  body.append(stripRow);
  body.append(el("div", { class: "hint" },
    "“Export the game's art” photographs any of the game's 202 animations frame by frame and hands "
    + "it over as a strip — paint over that and bring it back, which is how a first one usually "
    + "goes."));

  if (a.strip) {
    const shot = el("canvas", { width: a.strip.w * 2, height: a.strip.h * 2 });
    const sc = shot.getContext("2d");
    sc.imageSmoothingEnabled = false;
    const img = animSheetImage("freeform:" + sheetKey({ png: a.strip.png }), a.strip.png);
    const draw = () => sc.drawImage(img, 0, 0, a.strip.w * 2, a.strip.h * 2);
    if (img.complete) draw(); else img.addEventListener("load", draw, { once: true });
    body.append(el("div", { class: "sheetwrap", style: "max-height:200px" }, shot));
    body.append(el("div", { class: "hint" },
      `${a.strip.frames} frame${a.strip.frames === 1 ? "" : "s"} of ${a.strip.frameW} x ${a.strip.frameH}.`));
  }

  body.append(el("label", { style: "margin-top:10px" }, "Frames per game-frame"));
  const rateOut = el("span", { class: "statword" }, String(a.rate));
  body.append(el("div", { class: "row" },
    el("input", {
      type: "range", min: "1", max: "20", value: String(a.rate),
      oninput: (e) => { a.rate = Number(e.target.value); rateOut.textContent = e.target.value; touch(); },
    }), rateOut));
  body.append(el("div", { class: "hint" },
    "How long each of your frames holds, at 60 a second. 4 is a brisk flip; higher slows it down. "
    + (a.strip ? `Right now: ${a.strip.frames} frames × ${a.rate} = ${a.strip.frames * a.rate} frames total `
      + `(${(a.strip.frames * a.rate / 60).toFixed(1)}s).` : "")));

  body.append(el("label", { style: "margin-top:10px" },
    el("input", {
      type: "checkbox", checked: a.mirror,
      onchange: (e) => { a.mirror = e.target.checked; touch(); },
    }),
    " Flip it when the enemy uses this move"));
  body.append(el("div", { class: "hint" },
    "On, which is usually right: a spot chosen from the player's side of the screen mirrors to the "
    + "matching spot on the enemy's when they are the one attacking. Turn it off for something "
    + "meant to sit in one place regardless of who used it."));

  body.append(el("p", { class: "hint warn", style: "margin-top:12px" },
    "One thing this cannot do that the game's own animations can: recolour itself for the COLORS "
    + "option in Settings. Whatever you paint plays exactly as painted in every display mode — "
    + "which is exactly right if you paint in the four Game Boy greys, and a deliberate, fixed "
    + "look if you paint in colour."));

  freeformPreviewBlock(body, m, a, { lib, maxCoord });
}

/**
 * The one preview: the position, the picture, and the Play button all
 * driven by the same canvas -- dragging the position updates the very thing
 * Play plays, instead of a second, disconnected copy of the same screen.
 */
function freeformPreviewBlock(body, m, a, ctl) {
  const { lib, maxCoord } = ctl;
  body.append(el("div", { class: "who", style: "margin-top:14px" }, "Preview"));

  const posHost = el("div", {});
  const xyOut = el("span", { class: "hint" });
  const soundDef = moveSoundDef(m.data.anim);
  // A number input that gets torn down and rebuilt on every keystroke loses
  // the cursor mid-type, so it is created once here and only ever has its
  // value/readout touched afterwards -- the canvas is what redraws freely.
  const coordInput = el("input", {
    type: "number", min: "0", max: String(maxCoord), value: String(a.coord), style: "max-width:90px",
    oninput: (e) => {
      a.coord = Math.max(0, Math.min(maxCoord, Number(e.target.value) || 0));
      touch(); redrawPreview({ keepFocus: true });
    },
  });
  let preview = null;
  const redrawPreview = (opts = {}) => {
    posHost.textContent = "";
    preview = freeformPreview(a, {
      scale: 2, message: previewMessage(m),
      onPick: (ox, oy) => { a.coord = nearestCoordIndex(lib, ox, oy); touch(); redrawPreview(); },
      onPlaySound: soundDef && sfxPlayable() ? () => playCry(soundDef) : null,
    });
    posHost.append(preview.el);
    if (!opts.keepFocus) coordInput.value = String(a.coord);
    const c = lib?.baseCoords?.[a.coord] || null;
    xyOut.textContent = c ? `(x ${c.x}, y ${c.y})` : "";
  };
  redrawPreview();
  body.append(posHost);
  body.append(el("div", { class: "row", style: "align-items:center;margin-top:6px" },
    el("label", { style: "margin:0" }, "Position"), coordInput, xyOut));

  if (!a.strip) {
    body.append(el("p", { class: "hint warn", style: "margin-top:10px" }, "Paint a strip to preview it."));
    return;
  }
  body.append(el("div", { class: "row", style: "margin-top:6px" },
    el("button", { class: "primary fixed", onclick: () => preview.play() }, "▶ Play it"),
    el("span", { class: "hint" },
      soundDef ? "Picture and sound together, at the speed the game runs it."
        : "No sound picked yet — step 6.")));
}

/* -------------------------------------------------------------- 6. sound -- */

function stepMoveSound(host, m) {
  const anim = m.data.anim || (m.data.anim = { sound: "", pitch: 0, tempo: 128 });
  const imported = m._soundImport;
  const summary = imported ? "imported: " + imported.name : (anim.sound || "no sound yet");
  const body = moveStep(host, 6, "What it sounds like", summary);

  body.append(el("p", { class: "hint" },
    "Same arrangement as a Pokemon's cry: a sound effect out of the ROM's own sound banks, plus a "
    + "pitch and a tempo that bend it. The 165 moves share 48 sounds between them — the variety is "
    + "almost all in those two numbers, which is why a genuinely new noise is usually a matter of "
    + "dragging them rather than finding a recording — but below is a real recording too, if you'd "
    + "rather."));

  if (imported) {
    body.append(el("p", { class: "hint good" },
      "Using an imported recording instead of one of the game's own — see below to change or "
      + "remove it."));
  } else {
    const options = moveSoundOptions();
    if (!options.length) {
      body.append(el("p", { class: "hint warn" },
        "This copy of Oak's Lab was built without game data, which is where the sounds live."));
    } else {
      body.append(el("label", {}, "Start from"));
      const sel = el("select", {
        // A new sound starts from its own clean pitch and tempo -- otherwise a
        // bend left over from whatever was picked before comes along uninvited
        // and the "new" sound is quietly still warped.
        onchange: (e) => { anim.sound = e.target.value; anim.pitch = 0; anim.tempo = 128; touch(); renderMoveTab(); },
      }, el("option", { value: "" }, "— no sound (silent) —"));
      for (const name of options) {
        const users = movesUsingSound(name);
        sel.append(el("option", { value: name, selected: anim.sound === name },
          name + (users.length ? "  —  " + users.slice(0, 3).join(", ") : "")));
      }
      body.append(sel);

      if (!anim.sound) {
        body.append(el("p", { class: "hint" }, "Left empty, the move lands in silence."));
      } else {
        const slider = (label, key, min, max, dflt, hintText) => {
          const val = anim[key] ?? dflt;
          const out = el("span", { class: "statword" }, String(val));
          body.append(el("label", {}, label));
          body.append(el("div", { class: "row" },
            el("input", {
              type: "range", min: String(min), max: String(max), value: String(val),
              // The number keeps up live; the sound waits to be asked for, exactly
              // as the cry sliders do. A noise every few pixels of a drag tells you
              // nothing about any of them.
              oninput: (e) => { anim[key] = Number(e.target.value); out.textContent = e.target.value; touch(); },
            }), out));
          body.append(el("div", { class: "hint" }, hintText));
        };
        slider("Pitch", "pitch", 0, 255, 0,
          "Added to the raw pitch and wrapped, so it is not a simple low-to-high — it climbs, jumps and "
          + "climbs again. 0 leaves the sound exactly as the game has it.");
        slider("Tempo", "tempo", 1, 255, 128,
          "How fast it plays. 128 is the sound unbent; below that it drags and drops, above it hurries "
          + "and rises. The noise part of a sound ignores this, which is why a hit still lands crisply.");

        if (sfxPlayable()) {
          body.append(el("div", { class: "row", style: "margin-top:12px" },
            el("button", {
              class: "primary fixed",
              onclick: () => {
                if (!playCry(moveSoundDef(anim))) toast("That sound would not play — try another", true);
              },
            }, "▶ Play it"),
            el("span", { class: "hint" }, "Plays whatever the two sliders currently say.")));
          body.append(el("p", { class: "hint" },
            "Built the same way the game builds it — the sound chip running this effect's own program — "
            + "so what you hear is what the player will hear."));
        } else {
          body.append(el("p", { class: "hint warn" },
            "There is no way to play it in this copy of Oak's Lab — it was built without game data, "
            + "which is where the sound programs live."));
        }
      }
    }
  }

  renderAudioImport(body,
    () => (imported ? { name: imported.name, ext: imported.ext, b64: imported.b64 } : null),
    (v) => {
      if (v) {
        const key = (m.id || idFromName(m.data.name) || "MOVE") + "_SOUND";
        m._soundImport = { name: v.name, ext: v.ext, b64: v.b64, key };
        anim.sound = key;
        delete anim.pitch; delete anim.tempo;
      } else {
        delete m._soundImport;
        anim.sound = "";
      }
    },
    () => { touch(); renderMoveTab(); });
}

/* -------------------------------------------------------- 7. who learns it -- */

function stepMoveWho(host, m) {
  const id = m.id || idFromName(m.data.name);
  const users = monsKnowing(id);
  const body = moveStep(host, 7, "Who can use it",
    users.length ? `${users.length} of yours` : "nobody yet");

  body.append(el("p", { class: "hint" },
    "A move nothing knows is a move nobody sees. This is the same list as step 4 on the Pokemon "
    + "screen, from the other end."));

  if (!users.length) {
    body.append(el("p", { class: "hint warn" },
      "No Pokemon in this mod knows it yet."));
  } else {
    for (const u of users) {
      body.append(el("div", { class: "row", style: "margin-bottom:4px" },
        el("span", { style: "flex:1" }, monName(u.mon)),
        el("span", { class: "hint", style: "flex:1" }, u.how),
        el("button", {
          class: "fixed",
          onclick: () => { P.sel.mon = u.mon === P.monDraft ? "draft" : u.mon._uid; showContentSub("pokemon"); },
        }, "Open it")));
    }
  }

  const mine = [...P.entries.filter((e) => e.registry === "pokemon"), P.monDraft].filter(Boolean);
  if (mine.length) {
    body.append(el("label", { style: "margin-top:10px" }, "Give it to one of yours"));
    const sel = el("select", {}, el("option", { value: "" }, "— pick a Pokemon —"),
      ...mine.map((e) => el("option", { value: e === P.monDraft ? "draft" : e._uid }, monName(e))));
    const how = el("select", {},
      el("option", { value: "start" }, "knows it from the start"),
      el("option", { value: "learn" }, "learns it at level 20"),
      el("option", { value: "tm" }, "can be taught it by TM"));
    body.append(el("div", { class: "row" }, sel, how,
      el("button", {
        class: "fixed",
        onclick: () => {
          if (!sel.value) { toast("Pick a Pokemon first", true); return; }
          if (!id) { toast("Give the move a name first", true); return; }
          giveMoveToMon({ id }, { uid: sel.value, slot: how.value, level: 20 });
          touch(); renderMoveTab();
          toast("Given to that Pokemon");
        },
      }, "Give it")));
  }

  body.append(el("p", { class: "hint", style: "margin-top:10px" },
    "The game's own 151 can learn it too, but that means changing their records — add a "
    + "pokemon patch on the All records tab, or copy one on the Pokemon screen."));
}

// Every Pokemon in this mod that lists a move, and in which of the three ways.
function monsKnowing(id) {
  const out = [];
  if (!id) return out;
  for (const mon of [...P.entries.filter((e) => e.registry === "pokemon"), P.monDraft].filter(Boolean)) {
    const d = mon.data || {};
    const ways = [];
    if ((d.level1Moves || []).includes(id)) ways.push("from the start");
    for (const r of d.learnset || []) if (r.move === id) ways.push("at level " + r.level);
    if ((d.tmhm || []).includes(id)) ways.push("by TM");
    if (ways.length) out.push({ mon, how: ways.join(", ") });
  }
  return out;
}

/* ---------------------------------------------------------------- copy -- */

function copyMoveDialog() {
  const rows = Object.values(GAME?.moves || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  if (!rows.length) { toast("No move data — regenerate gamedata.json", true); return; }

  const body = el("div", {});
  body.append(el("p", { class: "hint" },
    "Takes its type, numbers, effect, animation and sound as a starting point. The copy gets its "
    + "own name and its own id, so the original is untouched — this is how most first moves start."));
  const sel = el("select", {}, ...rows.map((r) =>
    el("option", { value: r.id },
      `${r.name || r.id} — ${r.type.replace("_TYPE", "")}, ${r.power || "no"} power, ${r.pp} PP`)));
  body.append(el("input", {
    type: "search", placeholder: `search ${rows.length}…`,
    oninput: (e) => {
      const needle = e.target.value.trim().toLowerCase();
      sel.textContent = "";
      for (const r of rows) {
        if (needle && !(r.id + " " + (r.name || "")).toLowerCase().includes(needle)) continue;
        sel.append(el("option", { value: r.id },
          `${r.name || r.id} — ${r.type.replace("_TYPE", "")}, ${r.power || "no"} power, ${r.pp} PP`));
      }
    },
  }));
  body.append(sel);
  body.append(el("div", { class: "row", style: "margin-top:10px" },
    el("button", { class: "primary fixed", onclick: () => startMoveCopy(GAME.moves[sel.value]) }, "Copy it"),
    el("button", { class: "fixed", onclick: closeDialog }, "Cancel")));
  dialog("Start from one of the game's moves", body);
}

function startMoveCopy(rec) {
  if (!rec) return;
  const m = blankMove();
  m.data.name = "";
  m.data.type = rec.type;
  m.data.power = rec.power || 0;
  m.data.accuracy = rec.accuracy ?? 100;
  m.data.pp = rec.pp ?? 20;
  m.data.effect = rec.effect || "NO_ADDITIONAL_EFFECT";
  if (rec.highCrit) m.data.highCrit = true;
  if (rec.priority) m.data.priority = rec.priority;
  if (rec.multiHit) m.data.multiHit = rec.multiHit;
  // A fixed-damage move copied under a new name has to be given its amount
  // explicitly: the game's own five carry no number at all, because the engine
  // keeps a table keyed by their IDS and falls back to it. Copy Sonicboom
  // without this and you get a move that hits for nothing and says nothing.
  if (rec.fixedDamage !== undefined) m.data.fixedDamage = rec.fixedDamage;
  else if (rec.effect === "SPECIAL_DAMAGE_EFFECT") m.data.fixedDamage = ENGINE_FIXED_DAMAGE[rec.id] ?? 20;
  m.data.anim = { ...(rec.anim || { sound: "", pitch: 0, tempo: 128 }) };
  m._anim = { source: "game", id: rec.id };

  // The effect comes back as a preset rather than being reverse-engineered
  // into the guided answer: it already IS the right effect, and re-deriving
  // "30% paralysis" from PARALYZE_SIDE_EFFECT2 only to resolve it back to the
  // same id would be a round trip with nothing at the far end.
  m._fx = { mode: rec.effect === "NO_ADDITIONAL_EFFECT" ? "none" : "preset", preset: rec.effect };

  P.moveDraft = m;
  P.sel.move = "draft";
  touch(); closeDialog(); renderMoveTab();
  toast("Copied " + (rec.name || rec.id) + " — give it a name");
}

/* ------------------------------------------------- called from the mon tab -- */

/**
 * Start a move for a species, from that species' move list.
 *
 * The reason this exists: from the Pokemon screen, "it should know something
 * of its own" currently means going away, building a move, coming back, and
 * finding it in a 166-long dropdown. This carries the intent across so the
 * loop closes itself.
 */
function inventMoveFor(mon, slot, level) {
  guardMoveDraft(() => {
    const m = blankMove();
    m._wantedBy = { uid: mon === P.monDraft ? "draft" : mon._uid, slot, level };
    P.moveDraft = m;
    P.sel.move = "draft";
    touch();
    showContentSub("moves");
    toast("Name it, and it goes straight back to " + monName(mon));
  });
}
