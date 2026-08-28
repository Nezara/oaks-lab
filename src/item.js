"use strict";
/* ============================================================================
   Oak's Lab — the Items workspace.

   Same shape as Pokemon and Moves: one scrolling column of numbered steps.
   An item IS a plain `items` content record, so it lives in P.entries like
   everything else. The internal-only bits (`_effects`, and the small
   parameters the generated Lua below needs) ride alongside under
   underscore-prefixed keys and never reach the export.

   Read straight from the shipped engine source (src/inventory/ItemEffects.lua,
   src/battle/Catching.lua, src/ui/BagMenu.lua, src/ui/ShopMenu.lua) before
   writing any of this, because the schema pack describes what fields the
   `items` registry HAS, not which ones the engine actually reads. Four facts
   from that reading shape everything here:

   1. Almost everything a Gen 1 item "does" is hardcoded to its own id string
      in a ~600-line waterfall (`if itemId == "POTION" then heal 20`). There is
      no generic `healAmount` field. A copy of POTION under a new id heals
      nothing on its own — same trap as a Sonicboom copy dealing no damage,
      except moves at least have a `fixedDamage` field to backfill and items
      mostly don't.
   2. The two genuinely data-driven levers for a NEW item are `machine`
      (TM/HM) and `effect` -> the `item_effects` registry (a mod-authored
      `use(ctx)` function, the item-side twin of `move_effects`). Everything
      else needs its behavior reproduced as an `item_effects` block or it
      silently does nothing.
   3. A brand-new catchable Poke Ball turns out to BE possible, just not the
      way it first looks. `ItemEffects.use` only returns the "ball" signal
      BagMenu needs for a hardcoded 5-id list — but that check happens inside
      the hardcoded waterfall, which a `registeredEffect` (i.e. an item with
      its own `effect`) never reaches at all. A one-line branch
      (`if ctx.battle then return "ball" end`) is enough: BagMenu reads the
      string "ball" back and throws using the ITEM'S OWN id, and `balls` is a
      real per-id registry. So "throw it as a Poke Ball" is just one more row
      in the same behaviors list as healing/curing/etc — it needs a
      balls:register() companion (see itemBallRecords() below), but nothing
      about how it's picked is different from any other behavior.
   4. An item's `effect` is a single Lua function, but nothing stops that
      function from trying several distinct behaviors in sequence — vanilla
      FULL RESTORE already relies on exactly this: it isn't one effect, it's
      "try healing to full; only if the target is already at full HP AND has
      a status, cure the status instead." So the guided answer here is a
      short, user-orderable LIST of behaviors — Oak's Lab writes one
      `use(ctx)` that tries each in order, the same way FULL RESTORE's own two
      branches do.

   Also confirmed by reading the UI files:
   - `price` is real (buy price; mart sell price is `price / 2`).
   - `keyItem` is real and is what actually gates toss/sell — NOT the
     schema's `tossable` field, which is never read anywhere in Gen 1 (only in
     Gen 2 UI files). It is deliberately not exposed here as a toggle that
     would silently do nothing.
   - Items carry no flag field at all. "Does it set a flag" has a firm answer:
     no. The Found step below teaches the two working recipes instead —
     `check_item` as a door/mission gate (the vanilla Card Key/S.S. Ticket
     pattern, no flag needed) and `check_flag` + `give_item` + `set_flag` for
     a one-time pickup — and can build either script for you on the spot.
   - `needsTarget` is one value per item, decided by whether ANY behavior in
     the list needs a party-member target: a ball alone sets it false (so the
     bag doesn't ask "use on which Pokemon?" before throwing), but mixing a
     ball into a list that also heals has to set it true so the healing half
     still works, at the cost of the bag asking that question even on the
     turns it just gets thrown instead — a real, small rough edge of
     combining the two, not something this tool can smooth over.
   ========================================================================== */

/* ------------------------------------------------------------- the record -- */

const allItems = () => P.entries.filter((e) => e.registry === "items" && e.verb === "register");
const itemName = (it) => it?.data?.name || it?.id || "(unnamed)";
const isItemDraft = (it) => !!it && it === P.itemDraft;

function curItem() {
  if (P.sel.item === "draft") return P.itemDraft;
  return allItems().find((it) => it._uid === P.sel.item) || null;
}

// The item indices the game already uses. Mostly cosmetic (a save's bag slots
// sort by this), but a fresh one should still claim a number nothing else has.
function freeItemIndex() {
  const used = new Set();
  for (const r of Object.values(GAME?.items || {})) if (r.index) used.add(r.index);
  for (const it of allItems()) if (it.data?.index) used.add(it.data.index);
  if (P.itemDraft?.data?.index) used.add(P.itemDraft.data.index);
  let n = 153;                        // the 152 are taken; start after them
  while (used.has(n) && n < 255) n++;
  return n;
}

/**
 * A new item, pre-filled with the single safest answer: a key item with no
 * behaviors at all. Nothing in the engine is hardcoded against a new key
 * item's id, so this is the one starting point guaranteed to work exactly as
 * it looks the moment it has a name.
 */
function blankItem() {
  return {
    _uid: uid(), registry: "items", verb: "register", id: "",
    _effects: [],
    data: { name: "", price: 0, keyItem: true, index: freeItemIndex() },
  };
}

/* ------------------------------------------------- what the engine hardcodes -- */

// ItemEffects.lua's own tables, mirrored so Copy can tell what a vanilla item
// actually does and reproduce it rather than pretending an id copy would.
const VANILLA_HEAL_FLAT = { POTION: 20, SUPER_POTION: 50, HYPER_POTION: 200, FRESH_WATER: 50, SODA_POP: 60, LEMONADE: 80 };
const VANILLA_HEAL_FULL = new Set(["MAX_POTION"]);   // FULL_RESTORE is special-cased below
const VANILLA_STATUS_CURE = {
  ANTIDOTE: ["PSN"], BURN_HEAL: ["BRN"], ICE_HEAL: ["FRZ"], AWAKENING: ["SLP"],
  PARLYZ_HEAL: ["PAR"], FULL_HEAL: ["PSN", "BRN", "FRZ", "SLP", "PAR"],
};
const VANILLA_REVIVE = { REVIVE: "half", MAX_REVIVE: "full" };
const VANILLA_PP = {
  ETHER: { scope: "one", full: false }, MAX_ETHER: { scope: "one", full: true },
  ELIXER: { scope: "all", full: false }, MAX_ELIXER: { scope: "all", full: true },
};
const VANILLA_PP_UP = new Set(["PP_UP"]);
const VANILLA_STONES = new Set(["FIRE_STONE", "WATER_STONE", "THUNDER_STONE", "LEAF_STONE", "MOON_STONE"]);
const VANILLA_BALLS = new Set(["POKE_BALL", "GREAT_BALL", "ULTRA_BALL", "MASTER_BALL", "SAFARI_BALL"]);

// The five curable conditions medicine can reach (never SLP-inducing, never
// confusion/flinch -- those are move-side only). Reuses move.js's own labels
// so the wording never drifts between the two screens.
const CURABLE_STATUSES = ["PSN", "BRN", "FRZ", "PAR", "SLP"];

/**
 * What a vanilla item's record implies for the guided answer, so Copy can
 * land on the right behavior list (in the right order) already filled in
 * rather than leaving a silent do-nothing item behind. `unsupported` marks
 * the engine's own reserved overworld tools (rods, repels, X items, ...) that
 * have no template here at all -- the copy still lands, just empty.
 */
function categorizeVanillaItem(rec) {
  if (!rec) return { effects: [] };
  if (rec.machine) return { effects: [{ type: "teach" }], machine: rec.machine };
  if (VANILLA_BALLS.has(rec.id)) return { effects: [{ type: "ball", ballTier: rec.id.toLowerCase().replace("_ball", "") }] };
  if (rec.id === "FULL_RESTORE") {
    // Heal-first, deliberately: the real FULL_RESTORE only cures a status
    // when the target is ALREADY at full HP, so healing has to be tried
    // first or the cure branch would run before HP even matters.
    return { effects: [{ type: "heal_full" }, { type: "cure", cure: ["PSN", "BRN", "FRZ", "SLP", "PAR"] }] };
  }
  if (VANILLA_HEAL_FLAT[rec.id] !== undefined) return { effects: [{ type: "heal_flat", amt: VANILLA_HEAL_FLAT[rec.id] }] };
  if (VANILLA_HEAL_FULL.has(rec.id)) return { effects: [{ type: "heal_full" }] };
  if (VANILLA_STATUS_CURE[rec.id]) return { effects: [{ type: "cure", cure: [...VANILLA_STATUS_CURE[rec.id]] }] };
  if (VANILLA_REVIVE[rec.id]) return { effects: [{ type: VANILLA_REVIVE[rec.id] === "full" ? "revive_full" : "revive_half" }] };
  if (VANILLA_PP[rec.id]) {
    const p = VANILLA_PP[rec.id];
    const type = p.scope === "all" ? (p.full ? "pp_all_full" : "pp_all_flat") : (p.full ? "pp_full" : "pp_flat");
    return { effects: [{ type, amt: 10 }] };
  }
  if (VANILLA_PP_UP.has(rec.id)) return { effects: [{ type: "pp_up" }] };
  if (VANILLA_STONES.has(rec.id)) return { effects: [{ type: "stone" }] };
  if (rec.keyItem) return { effects: [] };
  return { unsupported: true, effects: [] };
}

// What the game already means by "this one's behavior belongs only to its
// own id" -- the honest reason a copy can't just inherit it. Shown on Copy
// for anything categorizeVanillaItem marks unsupported.
function otherItemNote(id) {
  const notes = {
    BICYCLE: "gets on/off the bike",
    OLD_ROD: "goes fishing", GOOD_ROD: "goes fishing", SUPER_ROD: "goes fishing",
    ESCAPE_ROPE: "leaves the cave instantly", TOWN_MAP: "opens the map screen",
    ITEMFINDER: "beeps near hidden items", COIN_CASE: "shows the coin count",
    POKE_FLUTE: "wakes sleeping Pokemon (and the two static Snorlax)",
    REPEL: "keeps weak wild Pokemon away for 100 steps",
    SUPER_REPEL: "keeps weak wild Pokemon away for 200 steps",
    MAX_REPEL: "keeps weak wild Pokemon away for 250 steps",
    X_ATTACK: "raises Attack one stage, battle only", X_DEFEND: "raises Defense one stage, battle only",
    X_SPEED: "raises Speed one stage, battle only", X_SPECIAL: "raises Special one stage, battle only",
    X_ACCURACY: "makes moves never miss, battle only",
    DIRE_HIT: "raises the critical-hit ratio, battle only",
    GUARD_SPEC: "blocks stat-lowering, battle only",
    POKE_DOLL: "flees a wild battle instantly",
  };
  return notes[id] || "something this tool doesn't have a template for";
}

/* ------------------------------------------------------------ effect types -- */

// Every behavior the list can offer, grouped for the dropdown. `fieldOnly`
// effects guard themselves with `not ctx.battle` in the generated Lua rather
// than gating the whole item, so a combo mixing (say) healing with an
// evolution stone still works in battle for the healing half. "ball" is the
// opposite: it only applies IN battle, and unlike everything else it doesn't
// touch the target at all -- BagMenu throws at the wild Pokemon regardless of
// what (if anything) was selected as the use target.
const EFFECT_TYPES = [
  { id: "heal_flat", group: "Healing", label: "Restores some HP", hasAmt: true, amtLabel: "How much HP", amtMax: 255, amtDefault: 20 },
  { id: "heal_full", group: "Healing", label: "Restores all HP" },
  { id: "cure", group: "Healing", label: "Cures a status condition", hasCure: true },
  { id: "revive_half", group: "Healing", label: "Revives a fainted Pokemon, to half HP" },
  { id: "revive_full", group: "Healing", label: "Revives a fainted Pokemon, to full HP" },
  { id: "pp_flat", group: "PP", label: "Restores some PP to one move", hasAmt: true, amtLabel: "How much PP", amtMax: 64, amtDefault: 10 },
  { id: "pp_full", group: "PP", label: "Restores all PP to one move" },
  { id: "pp_all_flat", group: "PP", label: "Restores some PP to every move", hasAmt: true, amtLabel: "How much PP", amtMax: 64, amtDefault: 10 },
  { id: "pp_all_full", group: "PP", label: "Restores all PP to every move" },
  { id: "pp_up", group: "PP", label: "Permanently raises a move's max PP", fieldOnly: true },
  { id: "level_up", group: "Growth", label: "Raises its level (Rare Candy)", fieldOnly: true, hasAmt: true, amtLabel: "How many levels", amtMax: 99, amtDefault: 1 },
  { id: "stone", group: "Evolution", label: "Matches an evolution stone", fieldOnly: true },
  { id: "teach", group: "Moves", label: "Teaches a move, TM/HM style", fieldOnly: true, needsMachine: true },
  { id: "ball", group: "Catching", label: "Throws it as a Poke Ball", battleOnly: true, isBall: true },
];
const effectType = (id) => EFFECT_TYPES.find((e) => e.id === id) || null;

// Which stone identity(ies) a "stone" effect matches. "SELF" is the item's
// own id -- what makes it a brand new stone a species can point an ITEM
// evolution straight at, on the Pokemon workspace's Evolution step. Ticking
// one of the game's five instead makes it a substitute for that exact
// vanilla stone, so a species that already lists e.g. MOON_STONE evolves for
// this item too, with no need to patch that species at all. Both can be
// ticked, and more than one vanilla stone can be ticked at once -- that is
// the whole point: "heals, and acts as a Moon Stone but not a Fire Stone."
const STONE_MIMICS = [
  { id: "SELF", label: "Its own kind of stone (a species can point straight at this item)" },
  { id: "FIRE_STONE", label: "Fire Stone" },
  { id: "WATER_STONE", label: "Water Stone" },
  { id: "THUNDER_STONE", label: "Thunder Stone" },
  { id: "LEAF_STONE", label: "Leaf Stone" },
  { id: "MOON_STONE", label: "Moon Stone" },
];
const stoneMimicLabel = (id) => STONE_MIMICS.find((s) => s.id === id)?.label || id;

// The label a behavior shows in the row/order summaries -- a plain lookup for
// everything except "stone", where the interesting part is WHICH stone(s),
// not that it is one.
function effectSummaryLabel(eff) {
  if (eff.type === "stone") {
    const mimics = eff.mimics && eff.mimics.length ? eff.mimics : ["SELF"];
    return "Evolution stone (" + mimics.map(stoneMimicLabel).join(", ") + ")";
  }
  return effectType(eff.type)?.label || eff.type;
}

const BALL_TIERS = [
  { id: "poke", label: "About as good as a Poke Ball", randMax: 255, hpFactor: 12, wobbleFactor: 255, tossAnim: "TOSS_ANIM" },
  { id: "great", label: "About as good as a Great Ball", randMax: 200, hpFactor: 8, wobbleFactor: 200, tossAnim: "GREATTOSS_ANIM" },
  { id: "ultra", label: "About as good as an Ultra Ball", randMax: 150, hpFactor: 12, wobbleFactor: 150, tossAnim: "ULTRATOSS_ANIM", flicker: true },
  { id: "master", label: "Always catches, like a Master Ball", autoCatch: true, tossAnim: "ULTRATOSS_ANIM", flicker: true },
  { id: "custom", label: "Custom numbers" },
];

/* ---------------------------------------------------------- generated Lua -- */

const customItemEffectId = (it) => (it.id || idFromName(it.data.name) || "ITEM") + "_EFFECT";

const monExpr = "(ctx.target.nickname or ctx.data.pokemon[ctx.target.species].name)";

/**
 * What `effect`/`item_effects` this item needs, given the guided answer.
 * Mirrors move.js's `effectFor` exactly: { id, custom } where id is what the
 * record's `effect` field should hold, and custom says whether Oak's Lab has
 * to ship the Lua for it (true) or the field is simply left unset (false).
 */
function itemEffectFor(it) {
  if ((it._effects || []).some((e) => e.type)) return { id: customItemEffectId(it), custom: true };
  return { id: null, custom: false };
}

function syncItemEffect(it) {
  const chosen = itemEffectFor(it);
  if (chosen.id) {
    if (it.data.effect !== chosen.id) { it.data.effect = chosen.id; touch(); }
  } else if (it.data.effect !== undefined) {
    delete it.data.effect; touch();
  }
  // needsTarget is a real, engine-read field (ItemEffects.needsTarget checks
  // the item's own value before falling back to id-guessing). Any behavior
  // besides a ball needs a party target; a ball alone doesn't -- see the
  // header note for what happens when both are in the same list.
  const effects = (it._effects || []).filter((e) => e.type);
  const nonBall = effects.filter((e) => e.type !== "ball");
  const wantsTarget = nonBall.length ? true : effects.length ? false : null;
  if (wantsTarget === null) { delete it.data.needsTarget; }
  else if (it.data.needsTarget !== wantsTarget) { it.data.needsTarget = wantsTarget; touch(); }
}

/**
 * The item_effects records this mod has to ship, as Lua source -- the
 * item-side twin of move.js's moveEffectRecords().
 */
function itemEffectRecords() {
  const out = [];
  const seen = new Set();
  for (const it of allItems()) {
    const chosen = itemEffectFor(it);
    if (!chosen.custom || seen.has(chosen.id)) continue;
    seen.add(chosen.id);
    const rec = buildItemEffectBody(it, chosen.id);
    if (rec) out.push(rec);
  }
  return out;
}

// One behavior's self-contained "if applicable then ... end" block. Each
// either returns (ending the item's use entirely) or falls through to
// whatever comes next in the list -- that fall-through is what makes the
// list orderable rather than a fixed bundle. Every branch but "ball" guards
// on `t` (ctx.target) being present, since a list that also contains a ball
// may have needsTarget forced false and reach here with no target picked.
function effectBlockLines(it, eff) {
  const L = [];
  switch (eff.type) {
    case "heal_flat": case "heal_full": {
      const full = eff.type === "heal_full";
      const amt = Math.max(1, Number(eff.amt) || 20);
      L.push(`      if t and t.hp > 0 and t.hp < t.stats.hp then`);
      L.push(`        local before = t.hp`);
      L.push(full ? `        t.hp = t.stats.hp` : `        t.hp = math.min(t.stats.hp, t.hp + ${amt})`);
      L.push(`        return "consumed", { string.format("%s's HP\\nwas restored!", ${monExpr}) }, { healedFrom = before }`);
      L.push(`      end`);
      break;
    }
    case "cure": {
      const cure = (eff.cure && eff.cure.length ? eff.cure : ["PSN"]);
      L.push(`      if t and t.status and ({ ${cure.map((s) => `${s} = true`).join(", ")} })[t.status] then`);
      L.push(`        t.status = nil`);
      L.push(`        return "consumed", { string.format("%s's\\nstatus returned\\nto normal!", ${monExpr}) }`);
      L.push(`      end`);
      break;
    }
    case "revive_half": case "revive_full": {
      const full = eff.type === "revive_full";
      L.push(`      if t and t.hp <= 0 then`);
      L.push(full ? `        t.hp = t.stats.hp` : `        t.hp = math.floor(t.stats.hp / 2)`);
      L.push(`        t.status = nil`);
      L.push(`        return "consumed", { string.format("%s\\nis revitalized!", ${monExpr}) }, { healedFrom = 0 }`);
      L.push(`      end`);
      break;
    }
    case "pp_flat": case "pp_full": {
      const full = eff.type === "pp_full";
      const amt = Math.max(1, Number(eff.amt) || 10);
      L.push(`      if t then`);
      L.push(`        local mv = t.moves[ctx.moveIndex or 1]`);
      L.push(`        local mdef = mv and ctx.data.moves[mv.id]`);
      L.push(`        local maxPP = mdef and (mdef.pp + (mv.ppUps or 0) * math.floor(mdef.pp / 5))`);
      L.push(`        if maxPP and mv.pp < maxPP then`);
      L.push(full ? `          mv.pp = maxPP` : `          mv.pp = math.min(maxPP, mv.pp + ${amt})`);
      L.push(`          return "consumed", { "PP was restored." }`);
      L.push(`        end`);
      L.push(`      end`);
      break;
    }
    case "pp_all_flat": case "pp_all_full": {
      const full = eff.type === "pp_all_full";
      const amt = Math.max(1, Number(eff.amt) || 10);
      L.push(`      if t then`);
      L.push(`        local restored = false`);
      L.push(`        for _, mv in ipairs(t.moves) do`);
      L.push(`          local mdef = ctx.data.moves[mv.id]`);
      L.push(`          local maxPP = mdef and (mdef.pp + (mv.ppUps or 0) * math.floor(mdef.pp / 5))`);
      L.push(`          if maxPP and mv.pp < maxPP then`);
      L.push(full ? `            mv.pp = maxPP` : `            mv.pp = math.min(maxPP, mv.pp + ${amt})`);
      L.push(`            restored = true`);
      L.push(`          end`);
      L.push(`        end`);
      L.push(`        if restored then return "consumed", { "PP was restored." } end`);
      L.push(`      end`);
      break;
    }
    case "pp_up": {
      L.push(`      if t and not ctx.battle then`);
      L.push(`        local mv = t.moves[ctx.moveIndex or 1]`);
      L.push(`        local mdef = mv and ctx.data.moves[mv.id]`);
      L.push(`        if mdef and (mv.ppUps or 0) < 3 then`);
      L.push(`          mv.ppUps = (mv.ppUps or 0) + 1`);
      L.push(`          mv.pp = mv.pp + math.floor(mdef.pp / 5)`);
      L.push(`          return "consumed", { string.format("%s's PP\\nincreased!", mdef.name) }`);
      L.push(`        end`);
      L.push(`      end`);
      break;
    }
    // Rare Candy's real behavior (src/inventory/ItemEffects.lua, engine
    // source) bumps level, recalculates exp for the new level, and
    // recalculates the whole stat block -- skipping the last two would
    // leave HP/stats stuck at the old level while the level number itself
    // moved on, so it is reproduced whole rather than as a plain
    // `t.level = t.level + n`. The formulas themselves are public, ordinary
    // Gen 1 mechanics (the comment atop the engine's own Stats.lua states
    // the stat one outright); nothing here reaches into the engine's
    // internals; it is self-contained, ordinary Lua the same as every
    // other behavior in this list.
    case "level_up": {
      const amt = Math.max(1, Math.min(99, Number(eff.amt) || 1));
      L.push(`      if t and not ctx.battle and t.level < 100 then`);
      L.push(`        local speciesDef = ctx.data.pokemon[t.species]`);
      L.push(`        local newLevel = math.min(100, t.level + ${amt})`);
      L.push(`        local curves = {`);
      L.push(`          MEDIUM_FAST = function(n) return n * n * n end,`);
      L.push(`          SLIGHTLY_FAST = function(n) return math.floor((3 * n * n * n) / 4) + 10 * n * n - 30 end,`);
      L.push(`          SLIGHTLY_SLOW = function(n) return math.floor((3 * n * n * n) / 4) + 20 * n * n - 70 end,`);
      L.push(`          MEDIUM_SLOW = function(n) return math.floor((6 * n * n * n) / 5) - 15 * n * n + 100 * n - 140 end,`);
      L.push(`          FAST = function(n) return math.floor((4 * n * n * n) / 5) end,`);
      L.push(`          SLOW = function(n) return math.floor((5 * n * n * n) / 4) end,`);
      L.push(`        }`);
      // Gen 1 stat formula, verbatim from Stats.lua's own header comment:
      // stat = floor(((base+DV)*2 + floor(ceil(sqrt(statExp))/4)) * level/100) + 5, HP +level+10.
      L.push(`        local function statAt(base, dv, se, level, isHP)`);
      L.push(`          local ev = math.floor(math.min(255, math.ceil(math.sqrt(se or 0))) / 4)`);
      L.push(`          local v = math.floor(((base + dv) * 2 + ev) * level / 100)`);
      L.push(`          if isHP then return v + level + 10 end`);
      L.push(`          return v + 5`);
      L.push(`        end`);
      L.push(`        t.level = newLevel`);
      L.push(`        local curve = curves[speciesDef.growthRate] or curves.MEDIUM_FAST`);
      L.push(`        t.exp = math.max(0, curve(newLevel))`);
      L.push(`        local dvs, se, old = t.dvs or {}, t.statExp or {}, t.stats`);
      L.push(`        local newStats = {}`);
      L.push(`        for _, key in ipairs({ "hp", "attack", "defense", "speed", "special" }) do`);
      L.push(`          newStats[key] = statAt(speciesDef.baseStats[key], dvs[key] or 0, se[key], newLevel, key == "hp")`);
      L.push(`        end`);
      L.push(`        t.stats = newStats`);
      L.push(`        t.hp = math.min(newStats.hp, t.hp + (newStats.hp - old.hp))`);
      L.push(`        return "consumed", { string.format("%s grew\\nto level %d!", ${monExpr}, newLevel) }, { leveledTo = newLevel }`);
      L.push(`      end`);
      break;
    }
    case "stone": {
      const mimics = eff.mimics && eff.mimics.length ? eff.mimics : ["SELF"];
      const matchSelf = mimics.includes("SELF");
      const others = mimics.filter((m) => m !== "SELF");
      const cond = [
        ...(matchSelf ? [`evo.item == ctx.itemId`] : []),
        ...(others.length ? [`otherStones[evo.item]`] : []),
      ];
      L.push(`      if t and not ctx.battle then`);
      L.push(`        local speciesDef = ctx.data.pokemon[t.species]`);
      if (others.length) L.push(`        local otherStones = { ${others.map((s) => `${s} = true`).join(", ")} }`);
      L.push(`        for _, evo in ipairs(speciesDef.evolutions or {}) do`);
      L.push(`          if evo.method == "ITEM" and (${cond.length ? cond.join(" or ") : "false"}) then`);
      L.push(`            return "consumed", nil, { evolveTo = evo.species }`);
      L.push(`          end`);
      L.push(`        end`);
      L.push(`      end`);
      break;
    }
    case "teach": {
      const m = it.data.machine || {};
      const move = luaStr(m.move || "SOME_MOVE");
      const kind = luaStr(m.kind === "HM" ? "learnkept" : "learn");
      L.push(`      if t and not ctx.battle then`);
      L.push(`        local speciesDef = ctx.data.pokemon[t.species]`);
      L.push(`        local canLearn = false`);
      L.push(`        for _, mv in ipairs(speciesDef.tmhm or {}) do if mv == ${move} then canLearn = true break end end`);
      L.push(`        if canLearn then`);
      L.push(`          local already = false`);
      L.push(`          for _, mv in ipairs(t.moves) do if mv.id == ${move} then already = true break end end`);
      L.push(`          if not already then return ${kind}, ${move} end`);
      L.push(`        end`);
      L.push(`      end`);
      break;
    }
    case "ball": {
      L.push(`      if ctx.battle then`);
      L.push(`        -- the string "ball" tells BagMenu to throw this at the wild Pokemon;`);
      L.push(`        -- the catch math itself is the balls:register() entry below.`);
      L.push(`        return "ball"`);
      L.push(`      end`);
      break;
    }
  }
  return L;
}

function buildItemEffectBody(it, id) {
  const effects = (it._effects || []).filter((e) => e.type);
  if (!effects.length) return null;

  const L = [];
  L.push(`    use = function(ctx)`);
  L.push(`      local t = ctx.target`);
  for (const eff of effects) for (const line of effectBlockLines(it, eff)) L.push(line);
  L.push(`      return "failed", { "It won't have\\nany effect." }`);
  L.push(`    end,`);

  const labels = effects.map(effectSummaryLabel);
  const why = labels.length > 1
    ? `${itemName(it)}: tries, in order — ${labels.join(" -> ")}.`
    : `${itemName(it)}: ${labels[0].toLowerCase()}, reproduced by hand since no field carries this for a new id.`;
  return { id, custom: true, body: L.join("\n"), why };
}

/**
 * The balls registry record a "throws it as a Poke Ball" behavior needs -- see
 * the header note for why this, plus the item_effects branch above, is what
 * actually makes a NEW ball id throwable at all.
 */
function itemBallRecords() {
  const out = [];
  for (const it of allItems()) {
    if (!it.id) continue;
    const ballEff = (it._effects || []).find((e) => e.type === "ball");
    if (!ballEff) continue;
    const tier = BALL_TIERS.find((t) => t.id === (ballEff.ballTier || "poke")) || BALL_TIERS[0];
    let data;
    if (tier.id === "custom") {
      const c = ballEff.ballCustom || {};
      data = {
        randMax: Math.max(0, Math.min(255, Number(c.randMax) ?? 200)),
        hpFactor: Math.max(1, Number(c.hpFactor) || 12),
        wobbleFactor: Math.max(1, Number(c.wobbleFactor) || 200),
        tossAnim: c.tossAnim || "ULTRATOSS_ANIM",
        ...(c.flicker ? { flicker: true } : {}),
      };
    } else if (tier.autoCatch) {
      data = { randMax: 0, autoCatch: true, tossAnim: tier.tossAnim, flicker: true };
    } else {
      data = { randMax: tier.randMax, hpFactor: tier.hpFactor, wobbleFactor: tier.wobbleFactor, tossAnim: tier.tossAnim, ...(tier.flicker ? { flicker: true } : {}) };
    }
    out.push({ id: it.id, data });
  }
  return out;
}

/* ------------------------------------------------------------- id renames -- */

// Renaming an item that a script, a species' evolution or a mart list already
// points at has to follow it, or those quietly end up referencing nothing.
function renameItemRefs(from, to) {
  for (const s of P.scripts || []) {
    for (const n of s.nodes || []) {
      if (["give_item", "take_item", "check_item"].includes(n.verb) && n.args?.itemId === from) n.args.itemId = to;
    }
  }
  for (const e of [...P.entries, P.monDraft].filter(Boolean)) {
    if (e.registry === "pokemon" && Array.isArray(e.data?.evolutions)) {
      for (const evo of e.data.evolutions) if (evo.item === from) evo.item = to;
    }
    if (e.registry === "text_pointers" && e.data) {
      for (const v of Object.values(e.data)) {
        if (v && Array.isArray(v.mart)) v.mart = v.mart.map((x) => (x === from ? to : x));
      }
    }
  }
}

/* --------------------------------------------------------------- pricing -- */

function vanillaItemPrices() {
  return Object.values(GAME?.items || {}).filter((r) => r.price > 0).map((r) => ({ id: r.id, name: r.name, price: r.price }));
}

function nearestItemsByPrice(value, n = 3) {
  return [...vanillaItemPrices()]
    .sort((a, b) => Math.abs(a.price - value) - Math.abs(b.price - value))
    .slice(0, n)
    .map((r) => `${r.name || r.id} ¥${r.price}`);
}

/* ------------------------------------------------------------------- UI -- */

function itemStep(host, n, title, note) {
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

function renderItemTab() {
  const host = $("#itemSteps");
  if (!host) return;
  host.textContent = "";

  const it = curItem();
  $("#itemTitle").innerHTML = it
    ? "Item <b>" + escapeText(itemName(it)) + "</b>" + (isItemDraft(it) ? " — not added yet" : "")
    : "Items";

  itemBar(host, it);
  if (!it) {
    host.append(el("div", { class: "step" },
      el("div", { class: "empty" },
        allItems().length
          ? "Pick one from the list above, or press New."
          : "No items in this mod yet. Press New to invent one, or Copy to start from one of the game's own.")));
    return;
  }

  syncItemEffect(it);
  stepItemName(host, it);
  stepItemBehaviors(host, it);
  stepItemPrice(host, it);
  stepItemSold(host, it);
  stepItemFound(host, it);
}

function guardItemDraft(proceed) {
  guardDraftReplace(P.itemDraft,
    { label: "“" + itemName(P.itemDraft) + "”", why: P.itemDraft && itemDraftBlocker(P.itemDraft), add: () => addItemDraft(P.itemDraft) },
    proceed);
}

function itemBar(host, cur) {
  const bar = el("div", { class: "workbar" });
  bar.append(el("button", { class: "fixed", onclick: () => guardItemDraft(copyItemDialog) }, "Copy"));
  bar.append(el("button", {
    class: "fixed",
    onclick: () => guardItemDraft(() => { P.itemDraft = blankItem(); P.sel.item = "draft"; touch(); renderItemTab(); }),
  }, "New"));

  const rows = allItems();
  if (rows.length || P.itemDraft) {
    bar.append(el("select", {
      onchange: (e) => { P.sel.item = e.target.value || null; renderItemTab(); },
    },
      el("option", { value: "" }, `— ${rows.length} in this mod —`),
      P.itemDraft ? el("option", { value: "draft", selected: cur === P.itemDraft },
        (itemName(P.itemDraft) === "(unnamed)" ? "new item" : itemName(P.itemDraft)) + "  (not added yet)") : null,
      ...rows.map((r) => el("option", { value: r._uid, selected: r === cur }, itemName(r)))));
  }

  if (isItemDraft(cur)) {
    const why = itemDraftBlocker(cur);
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", {
      id: "itemAddDraft", class: "primary fixed", disabled: !!why, title: why || "",
      onclick: () => addItemDraft(cur),
    }, "Add to the mod"));
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => discardItemDraft() }, "Discard"));
  } else if (cur) {
    // Delete used to live in a closing "That's it" step. That step is gone,
    // so it moves up here rather than disappearing with it -- Discard sits in
    // the same place for a draft, which is the same gesture on the same row.
    bar.append(el("div", { style: "flex:1" }));
    // Same spot "Add to the mod" sat in before it was added -- a quiet pulse
    // once editing pauses (flashUpdated, driven by touch()'s own debounce),
    // not a button, since edits already apply live and autosave as they're
    // made and there is nothing here to actually commit.
    bar.append(el("span", { id: "itemUpdated", class: "updated-flash" }, "Updated"));
    bar.append(el("button", { class: "fixed", onclick: () => showTab("script") }, "See the Lua"));
    bar.append(el("button", { class: "fixed danger", onclick: () => deleteItem(cur) }, "Delete"));
  }
  host.append(bar);
}

const itemDraftBlocker = (it) => {
  if (!it.data.name) return "Give it a name first.";
  if ((it._effects || []).some((e) => !e.type)) return "Finish or remove the empty behavior row.";
  const teaching = (it._effects || []).find((e) => e.type === "teach");
  if (teaching && !it.data.machine?.move) return "Pick the move it teaches.";
  return null;
};

function addItemDraft(it) {
  it.id = it.id || idFromName(it.data.name);
  it.data.id = it.id;
  P.entries.push(it);
  P.itemDraft = null;
  P.sel.item = it._uid;
  touch(); renderAll();
  showContentSub("items");
  toast(itemName(it) + " added");
}

function discardItemDraft() {
  if (!confirm("Throw this one away?")) return;
  P.itemDraft = null; P.sel.item = null;
  touch(); renderItemTab();
}

function deleteItem(it) {
  if (!confirm(`Delete ${itemName(it)}?`)) return;
  P.entries = P.entries.filter((e) => e !== it);
  P.sel.item = null;
  touch(); renderAll();
}

/* --------------------------------------------------------------- 1. name -- */

function stepItemName(host, it) {
  const body = itemStep(host, 1, "Name", it.id || null);

  body.append(el("label", {}, "What is it called?"));
  const idLine = el("div", { class: "hint" });
  const showId = () => { idLine.textContent = it.id ? `The engine will know it as ${it.id}.` : ""; };
  body.append(el("input", {
    value: it.data.name || "", placeholder: "Heart Scale", maxlength: "20",
    oninput: (e) => {
      const was = it.id;
      it.data.name = e.target.value.toUpperCase();
      it.id = idFromName(it.data.name);
      it.data.id = it.id;
      if (was && was !== it.id) renameItemRefs(was, it.id);
      showId();
      const t = $("#itemTitle");
      if (t) t.innerHTML = "Item <b>" + escapeText(itemName(it)) + "</b>" + (isItemDraft(it) ? " — not added yet" : "");
      touch();
    },
  }));
  showId();
  body.append(idLine);
  body.append(el("p", { class: "hint" },
    "Gen 1 draws item names in a twenty-character bag list, so anything much longer than "
    + "FULL RESTORE gets cut off."));

  if (isItemDraft(it)) {
    const why = itemDraftBlocker(it);
    body.append(el("p", { class: "hint" + (why ? " warn" : "") },
      why ? why + " Until then “Add to the mod” at the top of this tab stays greyed out."
          : "Ready — press “Add to the mod” at the top of this tab."));
  }
}

/* ---------------------------------------------------- 2. what it does -- */

// A dropdown per row plus "+ Another behavior", the same shape the Pokemon
// screen's evolutions list uses (stepMonEvo) rather than a checklist -- each
// row is one behavior, in the order it's tried, with its own sub-form and a
// remove button; reordering is the ▲/▼ pair rather than a separate list.
function stepItemBehaviors(host, it) {
  const effects = it._effects || (it._effects = []);
  const summary = effects.length
    ? effects.map(effectSummaryLabel).join(" -> ")
    : "nothing — a plain key item";
  const body = itemStep(host, 2, "What it does", summary);

  body.append(el("p", { class: "hint" },
    "Gen 1 has almost no fields for “what an item does” — the engine checks the item's own id "
    + "by name for nearly everything. Add as many rows as apply; Oak's Lab writes one function "
    + "that tries them in order."));

  if (!effects.length) {
    body.append(el("p", { class: "hint good" },
      "Nothing yet — that's a genuine, valid answer. Nothing in the engine is hardcoded against a "
      + "new key item's id, so this is the safest new item there is."));
  } else if (effects.length > 1) {
    body.append(el("p", { class: "hint" },
      "Tried top to bottom: the first row whose condition applies is what happens, and the rest "
      + "aren't reached that time. Order matters — the game's own FULL RESTORE is exactly this "
      + "shape (try a full heal; only when the target is already at full HP does it fall through to "
      + "curing a status instead), which is why healing is listed before curing when you copy it. "
      + "Reorder with the arrows below."));
  }

  const groups = {};
  for (const et of EFFECT_TYPES) (groups[et.group] || (groups[et.group] = [])).push(et);

  effects.forEach((eff, i) => {
    const et = effectType(eff.type);
    const card = el("div", { class: "evorow" });
    card.append(el("label", {}, "What it does"));
    card.append(el("select", {
      onchange: (e) => {
        const nt = e.target.value;
        const net = effectType(nt);
        const fresh = { type: nt };
        if (net?.hasAmt) fresh.amt = net.amtDefault;
        if (net?.hasCure) fresh.cure = ["PSN"];
        if (nt === "stone") fresh.mimics = ["SELF"];
        if (nt === "ball") fresh.ballTier = "poke";
        effects[i] = fresh;
        syncItemEffect(it); touch(); renderItemTab();
      },
    },
      el("option", { value: "" }, "— choose —"),
      ...Object.entries(groups).map(([group, list]) =>
        el("optgroup", { label: group }, ...list.map((o) =>
          el("option", { value: o.id, selected: o.id === eff.type },
            o.label + (o.fieldOnly ? " (field only)" : o.battleOnly ? " (battle only)" : "")))))));

    if (eff.type === "ball" && effects.length > 1) {
      card.append(el("p", { class: "hint warn", style: "margin-top:4px" },
        "Combined with something else here, the bag will still ask which Pokemon to use this on "
        + "before throwing it — needsTarget is one setting for the whole item, and anything besides "
        + "a ball needs that question asked."));
    }

    if (et) {
      const sub = el("div", { style: "margin-top:6px" });
      renderEffectParams(sub, it, eff, et);
      card.append(sub);
    }

    if (effects.length > 1) {
      card.append(el("div", { class: "row", style: "margin-top:8px" },
        el("button", {
          class: "fixed", disabled: i === 0,
          onclick: () => { [effects[i - 1], effects[i]] = [effects[i], effects[i - 1]]; touch(); renderItemTab(); },
        }, "▲ Move up"),
        el("button", {
          class: "fixed", disabled: i === effects.length - 1,
          onclick: () => { [effects[i + 1], effects[i]] = [effects[i], effects[i + 1]]; touch(); renderItemTab(); },
        }, "▼ Move down")));
    }

    card.append(el("button", {
      class: "danger", style: "margin-top:8px",
      onclick: () => { effects.splice(i, 1); syncItemEffect(it); touch(); renderItemTab(); },
    }, "Remove this behavior"));
    body.append(card);
  });

  body.append(el("button", {
    style: "margin-top:8px",
    onclick: () => { effects.push({ type: "" }); touch(); renderItemTab(); },
  }, effects.length ? "+ Another behavior" : "+ It does something when used"));

  if (effects.length) {
    const chosen = itemEffectFor(it);
    body.append(el("p", { class: "hint", style: "margin-top:10px" },
      effects.length > 1
        ? "Nothing in the game combines these on one item, so Oak's Lab writes a single item_effects "
          + "block that tries each row in order, registered as "
        : "Nothing in the game means exactly this for a new id, so Oak's Lab writes it — a short "
          + "item_effects block, reproducing the closest vanilla item's own logic, registered as ",
      el("code", {}, chosen.id), "."));
  }
}

function renderEffectParams(sub, it, eff, et) {
  if (et.hasAmt) {
    sub.append(el("label", {}, et.amtLabel));
    sub.append(el("input", {
      type: "number", min: "1", max: String(et.amtMax), value: String(eff.amt ?? et.amtDefault),
      oninput: (e) => { eff.amt = Math.max(1, Math.min(et.amtMax, Number(e.target.value) || 1)); touch(); },
    }));
  }
  if (et.hasCure) {
    eff.cure = eff.cure && eff.cure.length ? eff.cure : ["PSN"];
    sub.append(el("label", {}, "Cures"));
    for (const s of CURABLE_STATUSES) {
      const row = statusRow(s);
      sub.append(el("label", { class: "row", style: "margin-top:2px" },
        el("input", {
          type: "checkbox", checked: eff.cure.includes(s),
          onchange: (e) => {
            if (e.target.checked) { if (!eff.cure.includes(s)) eff.cure.push(s); }
            else eff.cure = eff.cure.filter((x) => x !== s);
            touch(); renderItemTab();
          },
        }), row?.label || s));
    }
  }
  if (et.id === "stone") {
    eff.mimics = eff.mimics && eff.mimics.length ? eff.mimics : ["SELF"];
    sub.append(el("label", {}, "Which stone(s) it acts as"));
    for (const m of STONE_MIMICS) {
      sub.append(el("label", { class: "row", style: "margin-top:2px" },
        el("input", {
          type: "checkbox", checked: eff.mimics.includes(m.id),
          onchange: (e) => {
            if (e.target.checked) { if (!eff.mimics.includes(m.id)) eff.mimics.push(m.id); }
            else eff.mimics = eff.mimics.filter((x) => x !== m.id);
            touch(); renderItemTab();
          },
        }), m.label));
    }
    sub.append(el("p", { class: "hint" },
      "Ticking one of the game's five makes this a substitute for that exact vanilla stone — a "
      + "species that already lists e.g. FIRE_STONE in its own Evolution entry (Vulpix, say) evolves "
      + "for this item too, with no need to patch that species at all. Tick several to act as more "
      + "than one, or just one to act as only that one (“heals, and is a Moon Stone, but not a "
      + "Fire or Leaf Stone” is exactly this: tick Moon Stone, leave the rest off). “Its own "
      + "kind of stone” is separate — it lets a species you control point an Evolution entry "
      + "straight at this item's own id, the way inventing a brand new stone normally would; leave it "
      + "unticked if you only want the substitute behavior."));
  }
  if (et.needsMachine) {
    const m = it.data.machine || (it.data.machine = { kind: "TM", move: "", number: 1 });
    sub.append(el("label", {}, "TM or HM"));
    sub.append(el("select", {
      onchange: (e) => { m.kind = e.target.value; touch(); },
    }, el("option", { value: "TM", selected: m.kind === "TM" }, "TM — used up when it teaches the move"),
       el("option", { value: "HM", selected: m.kind === "HM" }, "HM — kept forever")));
    sub.append(el("label", { style: "margin-top:6px" }, "Number (just for the name, e.g. TM07)"));
    sub.append(el("input", {
      type: "number", min: "1", max: "99", value: String(m.number || 1),
      oninput: (e) => { m.number = Math.max(1, Math.min(99, Number(e.target.value) || 1)); touch(); },
    }));
    sub.append(el("label", { style: "margin-top:6px" }, "Move it teaches"));
    sub.append(refSelect("moves", () => m.move, (v) => { m.move = v; touch(); renderItemTab(); }));
    sub.append(el("p", { class: "hint" },
      "Only teaches a species that already lists the move under its own TM/HM learnset (the "
      + "Pokemon screen's Moves step), same as the real game refusing a TM a species can't learn."));
  }
  if (et.isBall) {
    const tier = BALL_TIERS.find((t) => t.id === (eff.ballTier || "poke")) || BALL_TIERS[0];
    sub.append(el("label", {}, "Catch odds"));
    sub.append(el("select", {
      onchange: (e) => { eff.ballTier = e.target.value; touch(); renderItemTab(); },
    }, ...BALL_TIERS.map((t) => el("option", { value: t.id, selected: (eff.ballTier || "poke") === t.id }, t.label))));

    if (tier.id === "custom") {
      const c = eff.ballCustom || (eff.ballCustom = { randMax: 200, hpFactor: 12, wobbleFactor: 200 });
      const numField = (label, key, max) => {
        sub.append(el("label", { style: "margin-top:8px" }, label));
        sub.append(el("input", {
          type: "number", min: "1", max: String(max), value: String(c[key] ?? 1),
          oninput: (e) => { c[key] = Math.max(0, Math.min(max, Number(e.target.value) || 0)); touch(); },
        }));
      };
      numField("Ceiling of the catch roll (255 = Poke Ball, 150 = Ultra Ball, lower is worse)", "randMax", 255);
      numField("HP factor (lower makes low-HP targets easier)", "hpFactor", 255);
      numField("Wobble divisor (lower shakes more on a miss)", "wobbleFactor", 255);
      sub.append(el("label", { class: "row", style: "margin-top:8px" },
        el("input", { type: "checkbox", checked: !!c.flicker, onchange: (e) => { c.flicker = e.target.checked; touch(); } }),
        "Flickers on the toss, like Ultra/Master Ball"));
    }

    sub.append(el("p", { class: "hint" },
      "Also exports a balls:register() entry under this item's own id, carrying the numbers above — "
      + "that's what actually decides whether it catches anything."));
  }
}

/* ------------------------------------------------------------------ 3. price -- */

function stepItemPrice(host, it) {
  const body = itemStep(host, 3, "Price", it.data.keyItem ? "key item — not sold" : `¥${it.data.price || 0}`);

  body.append(el("label", {}, "Buy price"));
  body.append(el("input", {
    type: "number", min: "0", max: "99999", value: String(it.data.price ?? 0), disabled: !!it.data.keyItem,
    oninput: (e) => { it.data.price = Math.max(0, Number(e.target.value) || 0); touch(); renderItemTab(); },
  }));
  body.append(el("p", { class: "hint" },
    "A mart sells at this price and buys it back for half — both numbers come straight from this "
    + "one field, nothing else to set."));

  if (!it.data.keyItem && it.data.price > 0) {
    const near = nearestItemsByPrice(it.data.price);
    if (near.length) body.append(el("p", { class: "hint" }, "Closest in price: " + near.join(", ") + "."));
  }

  body.append(el("label", { class: "row", style: "margin-top:10px" },
    el("input", {
      type: "checkbox", checked: !!it.data.keyItem,
      onchange: (e) => {
        it.data.keyItem = e.target.checked;
        if (it.data.keyItem) it.data.price = 0;
        touch(); renderItemTab();
      },
    }), "This is a key item"));
  body.append(el("p", { class: "hint" },
    "The one field that actually controls tossing and selling — ", el("code", {}, "keyItem"),
    ". (The schema also lists a ", el("code", {}, "tossable"), " field; it's checked nowhere in "
    + "this engine, so Oak's Lab doesn't offer it as a toggle that would silently do nothing.)"));
}

/* --------------------------------------------------------------- 4. sold -- */

/**
 * Every shopkeeper this item could be added to: the game's own 14, plus any
 * this mod has already given a stock list of its own. A "shop NPC" in Gen 1
 * is not a special kind of person -- it is a TEXT_ constant whose
 * text_pointers entry carries a `mart` array -- so what is being picked here
 * really is a person, identified the way the engine identifies them.
 */
function allShopkeepers() {
  const out = [];
  for (const [mapId, list] of Object.entries(GAME?.marts || {})) {
    for (const m of list) out.push({ mapId, constant: m.constant, group: m.group, stock: m.stock, vanilla: true });
  }
  return out.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.constant.localeCompare(b.constant));
}

// This mod's own text_pointers patches, as { group -> { constant -> {mart} } }.
// One record per text_pointers group, so several clerks on the same floor
// share an entry rather than fighting over it.
function martPatchEntry(group, constant) {
  let rec = P.entries.find((e) => e.registry === "text_pointers" && e.id === group);
  if (!rec) {
    rec = { _uid: uid(), registry: "text_pointers", verb: "patch", id: group, data: {} };
    P.entries.push(rec);
  }
  rec.data[constant] ||= {};
  rec.data[constant].mart ||= [];
  return rec;
}

// Which of this mod's mart patches already stock this item, as the same
// {mapId, constant, group} shape allShopkeepers uses.
function shopsStocking(itemId) {
  const out = [];
  if (!itemId) return out;
  for (const e of P.entries) {
    if (e.registry !== "text_pointers" || !e.data) continue;
    for (const [constant, v] of Object.entries(e.data)) {
      if (Array.isArray(v?.mart) && v.mart.includes(itemId)) {
        out.push({ group: e.id, constant, stock: v.mart });
      }
    }
  }
  return out;
}

function stepItemSold(host, it) {
  const stocking = shopsStocking(it.id);
  const body = itemStep(host, 4, "Where it's sold",
    stocking.length ? `${stocking.length} shop${stocking.length > 1 ? "s" : ""}` : "not sold anywhere");

  body.append(el("p", { class: "hint" },
    "A shop in Gen 1 is a person, not a building: a clerk's ", el("code", {}, "TEXT_"),
    " constant carries the list of what they sell. Adding this item to one means editing that "
    + "clerk — which is fine, and reversible: your mod appends to their stock and turning it off "
    + "puts their counter back exactly as it was."));

  if (stocking.length) {
    body.append(el("h2", { style: "margin-top:12px" }, "Sold by"));
    for (const s of stocking) {
      const row = el("div", { class: "row", style: "margin-top:4px" });
      row.append(el("span", { style: "flex:1" }, shopLabel(s.group, s.constant)));
      row.append(el("span", { class: "hint" }, s.stock.length + " item" + (s.stock.length > 1 ? "s" : "")));
      row.append(el("button", {
        class: "fixed danger",
        onclick: () => { removeFromShop(it.id, s.group, s.constant); touch(); renderItemTab(); },
      }, "Remove"));
      body.append(row);
    }
  }

  const shops = allShopkeepers();
  if (!shops.length) {
    body.append(el("p", { class: "hint warn", style: "margin-top:10px" },
      "No shop data in this copy of Oak's Lab — regenerate gamedata.json to pick a shopkeeper."));
    return;
  }

  body.append(el("label", { style: "margin-top:12px" }, "Add it to a shopkeeper"));
  const sel = el("select", {});
  sel.append(el("option", { value: "" }, "— pick a shop —"));
  for (const s of shops) {
    const already = stocking.some((x) => x.group === s.group && x.constant === s.constant);
    sel.append(el("option", { value: s.group + "|" + s.constant, disabled: already },
      `${s.mapId} — ${shopClerkName(s.constant, s.group)} (${s.stock.slice(0, 3).map(itemLabelFor).join(", ")}${s.stock.length > 3 ? "…" : ""})`
      + (already ? "  ✓ already" : "")));
  }
  body.append(sel);
  body.append(el("button", {
    class: "fixed", style: "margin-top:6px",
    onclick: () => {
      // The whole shop list stays browsable before the item has a name --
      // seeing who sells what is worth doing while still deciding. Only the
      // write needs an id, because the stock list is a list of ids.
      if (!it.id) { toast("Give the item a name first — a shop stocks it by id", true); return; }
      if (!sel.value) { toast("Pick a shop first", true); return; }
      const [group, constant] = sel.value.split("|");
      addToShop(it.id, group, constant);
      touch(); renderItemTab();
      toast("Added to that shop's stock");
    },
  }, "Add it to that shop"));

  body.append(el("p", { class: "hint", style: "margin-top:8px" },
    "The clerk's existing stock is copied across and yours appended to the end, so nothing they "
    + "already sold disappears. They charge the price from step 3 and buy it back for half."));
}

/**
 * A clerk's TEXT_ constant is the only name the engine has for them, so this
 * makes it readable. The constant repeats the map inside itself
 * (TEXT_CELADONMART2F_CLERK1), and the map is already shown beside it, so the
 * repeated half is dropped rather than printed twice.
 */
function shopClerkName(constant, group) {
  let s = constant.replace(/^TEXT_/, "");
  if (group) {
    const prefix = group.toUpperCase().replace(/[^A-Z0-9]/g, "");
    // walk off the leading words that spell out the group's own name
    let head = "";
    const parts = s.split("_");
    while (parts.length > 1 && prefix.startsWith((head + parts[0]).replace(/[^A-Z0-9]/g, ""))) {
      head += parts.shift();
    }
    if (parts.length) s = parts.join("_");
  }
  return s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const shopLabel = (group, constant) => group + " — " + shopClerkName(constant, group);

const itemLabelFor = (id) =>
  GAME?.items?.[id]?.name || allItems().find((x) => x.id === id)?.data?.name || id;

/**
 * Put this item on a clerk's counter.
 *
 * The whole vanilla stock is copied into the patch first: `text_pointers` is
 * `deep` merge semantics, but `mart` is a plain array inside it -- a patch
 * naming only the new item would replace the list rather than extend it, and
 * the clerk would end up selling one thing.
 */
function addToShop(itemId, group, constant) {
  const rec = martPatchEntry(group, constant);
  const mart = rec.data[constant].mart;
  if (!mart.length) {
    const vanilla = allShopkeepers().find((s) => s.group === group && s.constant === constant);
    if (vanilla) mart.push(...vanilla.stock);
  }
  if (!mart.includes(itemId)) mart.push(itemId);
}

function removeFromShop(itemId, group, constant) {
  const rec = P.entries.find((e) => e.registry === "text_pointers" && e.id === group);
  if (!rec?.data?.[constant]?.mart) return;
  rec.data[constant].mart = rec.data[constant].mart.filter((x) => x !== itemId);
  // A patch that now only restates the clerk's vanilla stock is noise -- drop
  // it so disabling the mod is not the only way back to the original counter.
  const vanilla = allShopkeepers().find((s) => s.group === group && s.constant === constant);
  const same = vanilla && vanilla.stock.length === rec.data[constant].mart.length
    && vanilla.stock.every((x, i) => rec.data[constant].mart[i] === x);
  if (same || !rec.data[constant].mart.length) delete rec.data[constant];
  if (!Object.keys(rec.data).length) P.entries = P.entries.filter((e) => e !== rec);
}

/* -------------------------------------------------------------- 5. found -- */

/**
 * An item lying on the ground is a map OBJECT wearing the Poke Ball sprite --
 * exactly how every vanilla item ball is stored (VIRIDIANFOREST_ANTIDOTE and
 * friends are `sprite = "SPRITE_POKE_BALL"` objects with a TEXT_ constant).
 * Vanilla resolves that constant to hand-written assembly, which a mod cannot
 * reach; what a mod CAN do is register its own map_scripts talk entry for its
 * own constant, and that is what gets built here: give the item, then hide the
 * ball so it does not come back.
 */
function itemBallsFor(it) {
  const out = [];
  if (!it.id) return out;
  for (const m of [...P.maps, ...P.mapDrafts]) {
    (m.rec.objects || []).forEach((o, i) => {
      if (o._itemBall === it.id) out.push({ map: m, obj: o, i });
    });
  }
  return out;
}

function stepItemFound(host, it) {
  const balls = itemBallsFor(it);
  const body = itemStep(host, 5, "Where it's found",
    balls.length ? balls.map((b) => b.map.id).join(", ") : "nowhere in the world");

  body.append(el("p", { class: "hint" },
    "An item lying on the ground is a Poke Ball on the map — the same way every one of the game's "
    + "own is stored. Pick a map and tap the spot, and Oak's Lab places the ball and writes the "
    + "script behind it: pick it up once, and it is gone for good."));

  for (const b of balls) {
    const row = el("div", { class: "row", style: "margin-top:4px" });
    row.append(el("span", { style: "flex:1" }, `${b.map.id} at cell ${b.obj.x}, ${b.obj.y}`));
    row.append(el("button", {
      class: "fixed danger",
      onclick: () => { removeItemBall(it, b); touch(); renderItemTab(); },
    }, "Remove"));
    body.append(row);
  }

  body.append(el("label", { style: "margin-top:12px" }, "Put one on a map"));
  const mapId = it._placeMap || "";
  body.append(refSelect("maps", () => mapId, (v) => {
    it._placeMap = v; touch(); renderItemTab();
  }, { blank: "— pick a map —" }));

  if (!mapId) {
    body.append(el("p", { class: "hint" }, "Pick the map it lies on, then tap the spot."));
    return;
  }

  const marker = { x: -1, y: -1 };
  body.append(el("div", { style: "margin:10px 0;overflow:auto" },
    miniMap(mapId, marker, (cx, cy) => {
      // Browsing maps to decide where something should go is worth doing
      // before naming it; only the placement itself needs an id, since the
      // ball's object name, flag and give_item argument are all built from it.
      if (!it.id) { toast("Give the item a name first — the ball is named after it", true); return; }
      addItemBall(it, mapId, cx, cy);
      touch(); renderItemTab();
      toast(`${itemName(it)} placed on ${mapId}`);
    })));
  body.append(el("p", { class: "hint" },
    "Tap the map to drop one there. Red squares are cells the player cannot walk on — a ball on "
    + "one of those can still be reached from beside it, the way the game's own hidden-corner "
    + "items are."));

  if (GAME?.maps?.[mapId]) {
    body.append(el("p", { class: "hint warn" },
      `${mapId} is one of the game's own maps. The ball is appended to it, so nothing vanilla is `
      + "removed — and turning your mod off puts the map back exactly as it was."));
  }
}

// The TEXT_ constant and object name a placed ball is known by. Both have to
// be unique per placement, since two of the same item on one map would
// otherwise share a script and hide each other.
function itemBallNames(it, mapId, existing) {
  const base = (it.id || "ITEM") + "_BALL";
  let n = 1;
  const taken = new Set(existing.map((o) => o.name));
  while (taken.has(base + (n > 1 ? "_" + n : ""))) n++;
  const name = base + (n > 1 ? "_" + n : "");
  return { name, text: "TEXT_" + name, flag: "GOT_" + name };
}

function addItemBall(it, mapId, x, y) {
  const target = mapRecordFor(mapId);
  if (!target) { toast("Load game data before placing an item", true); return; }

  const objects = target.rec.objects || (target.rec.objects = []);
  const { name, text, flag } = itemBallNames(it, mapId, objects);

  // Same index rule the NPC workspace uses: vanilla indices are single
  // digits, so start well clear of them and the save keys never collide.
  const used = new Set(objects.map((o) => o.index));
  let index = 90;
  while (used.has(index)) index++;

  objects.push({
    _itemBall: it.id, name, sprite: "SPRITE_POKE_BALL",
    movement: "STAY", range: "NONE", x, y, text, index,
  });

  // The script the ball runs. Vanilla's is assembly a mod cannot reach, so
  // this is the same behaviour written as ordinary blocks: give it, remember
  // it, and take the ball away.
  //
  // The flag branch is belt-and-braces rather than the real mechanism --
  // hide_object is persistent, so a picked-up ball is already gone. Its YES
  // side just hides the ball again (silently, no empty text box) so a save
  // that somehow sees it standing there cannot be farmed for a second copy.
  const s = newScript("pick up " + itemName(it), mapId, "talk");
  s.textKey = text;
  s.nodes = [];
  const chk = { uid: uid(), verb: "check_flag", args: { name: flag }, x: 40, y: 40, next: null, no: null };
  const rehide = { uid: uid(), verb: "hide_object", args: { mapId, objName: name }, x: 40, y: 160, next: null, no: null };
  const give = { uid: uid(), verb: "give_item", args: { itemId: it.id, count: 1 }, x: 260, y: 160, next: null, no: null };
  const mark = { uid: uid(), verb: "set_flag", args: { name: flag }, x: 260, y: 280, next: null, no: null };
  const hide = { uid: uid(), verb: "hide_object", args: { mapId, objName: name }, x: 260, y: 400, next: null, no: null };
  chk.next = rehide.uid; chk.no = give.uid;
  give.next = mark.uid; mark.next = hide.uid;
  s.start = chk.uid;
  s.nodes.push(chk, rehide, give, mark, hide);
  P.scripts.push(s);
}

function removeItemBall(it, b) {
  b.map.rec.objects.splice(b.i, 1);
  P.scripts = P.scripts.filter((s) => s.textKey !== b.obj.text);

  // A vanilla patch holds a FULL copy of the map and only exports what sits
  // past `_vanillaCounts` (mapRecordForExport), so "is it empty" is not
  // `objects.length` -- it is "does anything sit past the vanilla count in
  // any of the three lists". A patch that adds nothing exports as a
  // do-nothing record, so drop it entirely.
  if (b.map.verb !== "patch" || b.map.dirtyBlocks) return;
  const counts = b.map.rec._vanillaCounts;
  if (!counts) return;
  const addsNothing = ["warps", "signs", "objects"]
    .every((k) => (b.map.rec[k] || []).length <= (counts[k] || 0));
  if (addsNothing) P.maps = P.maps.filter((m) => m !== b.map);
}

/* ---------------------------------------------------------------- copy -- */

function copyItemDialog() {
  const rows = Object.values(GAME?.items || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  if (!rows.length) { toast("No item data — regenerate gamedata.json", true); return; }

  const body = el("div", {});
  body.append(el("p", { class: "hint" },
    "Copies its price and what it does. Most of what a vanilla item actually does is hardcoded to "
    + "its own id in the engine, not carried in a field — so rather than pretend an id copy would "
    + "keep working, Oak's Lab regenerates that behavior as a new item_effects block wherever one is "
    + "needed (FULL RESTORE, which is really two behaviors, copies as both in the right order). The "
    + "original is untouched either way — and you can still add more behaviors to the copy afterward."));
  const sel = el("select", {}, ...rows.map((r) =>
    el("option", { value: r.id }, `${r.name || r.id} — ¥${r.price ?? 0}${r.keyItem ? ", key item" : ""}`)));
  body.append(el("input", {
    type: "search", placeholder: `search ${rows.length}…`,
    oninput: (e) => {
      const needle = e.target.value.trim().toLowerCase();
      sel.textContent = "";
      for (const r of rows) {
        if (needle && !(r.id + " " + (r.name || "")).toLowerCase().includes(needle)) continue;
        sel.append(el("option", { value: r.id }, `${r.name || r.id} — ¥${r.price ?? 0}${r.keyItem ? ", key item" : ""}`));
      }
    },
  }));
  body.append(sel);
  body.append(el("div", { class: "row", style: "margin-top:10px" },
    el("button", { class: "primary fixed", onclick: () => startItemCopy(GAME.items[sel.value]) }, "Copy it"),
    el("button", { class: "fixed", onclick: closeDialog }, "Cancel")));
  dialog("Start from one of the game's items", body);
}

function startItemCopy(rec) {
  if (!rec) return;
  const it = blankItem();
  it.data.name = "";
  it.data.price = rec.price || 0;
  it.data.keyItem = !!rec.keyItem;

  const guess = categorizeVanillaItem(rec);
  it._effects = (guess.effects || []).map((e) => ({ ...e }));
  if (guess.machine) it.data.machine = { ...guess.machine };

  P.itemDraft = it;
  P.sel.item = "draft";
  syncItemEffect(it);
  touch(); closeDialog(); renderItemTab();

  if (guess.unsupported) {
    toast(`Copied ${rec.name || rec.id} — but its real behavior (${otherItemNote(rec.id)}) is one `
      + "of the engine's own reserved tools tied to its exact id, so this starts as a plain item "
      + "with no effect. Give it a name.", true);
  } else {
    toast("Copied " + (rec.name || rec.id) + " — give it a name");
  }
}
