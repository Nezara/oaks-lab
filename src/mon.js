"use strict";
/* ============================================================================
   Oak's Lab — the Pokemon workspace.

   Same shape as the NPC screen: one scrolling column of numbered steps you
   can come back to in any order. No node editor -- a species is a pile of
   numbers and lists, not a conversation, so there is nothing here to wire up.

   A species IS a plain `pokemon` content record, so it lives in P.entries
   like everything else and the Content/All-records tab keeps seeing it. The
   only things that ride alongside are authoring answers the engine has no
   field for -- imported art under `_art`, the drafting flag -- and those are
   stripped on the way out.

   Two pieces of this are not just a form:

     - the stat meter (step 3) measures the 151 at RUNTIME rather than
       carrying thresholds that would rot, and compares against the right
       cohort: a 400-total is strong for something that still evolves and
       ordinary for a final form.

     - the evolution chain (step 5) can create the NEXT species as its own
       draft, pre-linked, so "and then it becomes..." is one button rather
       than remembering to come back and wire two records together.
   ========================================================================== */

/* ------------------------------------------------------------- the record -- */

const MON_STATS = ["hp", "attack", "defense", "speed", "special"];
const MON_STAT_LABEL = { hp: "HP", attack: "Attack", defense: "Defense", speed: "Speed", special: "Special" };

// Gen 1's ten wild slots and what each is worth, from the engine's own
// cumulative thresholds out of 256 (FieldDefaults.CONSTANTS.encounterBuckets,
// which src/world/Encounter.lua rolls against). Slot 1 is common, slot 10 is
// the one people hunt for.
const ENCOUNTER_BUCKETS = [51, 102, 141, 166, 191, 216, 229, 242, 253, 256];
const SLOT_PCT = ENCOUNTER_BUCKETS.map((t, i) => (t - (ENCOUNTER_BUCKETS[i - 1] || 0)) / 256 * 100);

const allMons = () => P.entries.filter((e) => e.registry === "pokemon" && e.verb === "register");
const monName = (m) => m?.data?.name || m?.id || "(unnamed)";
const isMonDraft = (m) => !!m && m === P.monDraft;

function curMon() {
  if (P.sel.mon === "draft") return P.monDraft;
  return allMons().find((m) => m._uid === P.sel.mon) || null;
}

/* The dex numbers the game already uses, so a new one gets the next free
   number rather than colliding with BULBASAUR. */
function freeDexNumber() {
  const used = new Set();
  for (const r of Object.values(GAME?.pokemon || {})) if (r.dex) used.add(r.dex);
  for (const m of allMons()) if (m.data?.dex) used.add(m.data.dex);
  if (P.monDraft?.data?.dex) used.add(P.monDraft.data.dex);
  let n = 152;                       // the 151 are taken; start after them
  while (used.has(n)) n++;
  return n;
}

/**
 * A new species, pre-filled with something that already works.
 *
 * Every required field carries a value, so the record is exportable the
 * moment it has a name -- a half-filled species that crashes the engine on
 * load is a much worse first experience than a bland one that runs.
 */
function blankMon() {
  return {
    _uid: uid(), registry: "pokemon", verb: "register", id: "", _art: {},
    data: {
      name: "", dex: freeDexNumber(), types: ["NORMAL"],
      baseStats: { hp: 50, attack: 50, defense: 50, speed: 50, special: 50 },
      baseExp: 64, catchRate: 45, growthRate: "MEDIUM_FAST",
      frontSize: 5, spriteFront: "", spriteBack: "",
      level1Moves: [], learnset: [], evolutions: [],
    },
  };
}

/* --------------------------------------------------------- what is normal -- */

/**
 * Which group of the game's own Pokemon this one should be judged against.
 *
 * A base form and a fully-evolved one are not the same kind of thing, and
 * lumping them together is what makes a "is this too strong" reading useless:
 * 400 is enormous for something that still evolves and unremarkable for a
 * final form. Derived from the evolution graph rather than declared, so it
 * follows the record the user is actually building.
 */
const monCohort = (m) => ((m?.data?.evolutions || []).length ? "evolves" : "grown");

// The same question asked of a vanilla record: does it still evolve?
function vanillaCohorts() {
  const rows = Object.values(GAME?.pokemon || {}).filter((r) => r.baseStats);
  const out = { evolves: [], grown: [] };
  for (const r of rows) out[(r.evolutions || []).length ? "evolves" : "grown"].push(r);
  return out;
}

const monBst = (s) => MON_STATS.reduce((n, k) => n + (Number(s?.[k]) || 0), 0);

/**
 * Where `value` sits inside `sorted` — 0..1, and the count below it.
 *
 * Plain "what fraction of the game is weaker than this", which is a thing a
 * person can act on. Not a normal distribution or a standard deviation: those
 * would be more precise about a set of 151 hand-authored numbers than the
 * numbers deserve.
 */
function percentileIn(sorted, value) {
  if (!sorted.length) return null;
  let below = 0;
  for (const v of sorted) { if (v < value) below++; else break; }
  return below / sorted.length;
}

/**
 * Everything the meter needs about one set of Pokemon, measured on the spot.
 *
 * Shared by the evolve/grown cohort and the type cohort below -- both are
 * "some subset of the 151, what does normal look like for them", they just
 * pick that subset differently. Recomputed per render rather than cached: it
 * is at most 151 numbers, and a cache would have to know when the user added
 * a species of their own or changed its type.
 */
function bandFromRows(rows) {
  if (!rows.length) return null;
  const at = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  const band = { n: rows.length, rows };
  const totals = rows.map((r) => monBst(r.baseStats)).sort((a, b) => a - b);
  band.total = { sorted: totals, lo: at(totals, 0.1), mid: at(totals, 0.5), hi: at(totals, 0.9),
    min: totals[0], max: totals[totals.length - 1] };
  for (const k of MON_STATS) {
    const v = rows.map((r) => Number(r.baseStats[k]) || 0).sort((a, b) => a - b);
    band[k] = { sorted: v, lo: at(v, 0.1), mid: at(v, 0.5), hi: at(v, 0.9), min: v[0], max: v[v.length - 1] };
  }
  return band;
}

function cohortBand(cohort) {
  return bandFromRows(vanillaCohorts()[cohort] || []);
}

/**
 * What's normal for a TYPE, not for the game as a whole.
 *
 * A Rock-type's defense reads as merely decent against every Pokemon in the
 * game, and unremarkable against nothing at all -- Rock as a type runs high
 * there. Counted by "carries this type at all", first or second, so a
 * dual-type species shows up in both its types' bands.
 */
function typeBand(type) {
  if (!type) return null;
  const rows = Object.values(GAME?.pokemon || {}).filter((r) => r.baseStats && (r.types || []).includes(type));
  return bandFromRows(rows);
}

// The plain-words reading. Deliberately four buckets and no numbers: the
// numbers are right there on the bar, and "a bit high" is the part that is
// actually a judgement.
function verdictOf(pct) {
  if (pct == null) return { word: "", cls: "" };
  if (pct < 0.1) return { word: "very low", cls: "bad" };
  if (pct < 0.25) return { word: "low", cls: "warn" };
  if (pct > 0.9) return { word: "very high", cls: "bad" };
  if (pct > 0.75) return { word: "high", cls: "warn" };
  return { word: "normal", cls: "good" };
}

/**
 * The percentile as a sentence, phrased whichever direction reads naturally.
 *
 * A LOW value said as "above 1% of them" is technically the same fact but
 * reads as if it is arguing with itself right after the word "low". Above the
 * middle says how much it beats; at or under it says how much it falls short
 * of -- always the framing that agrees with the verdict word next to it.
 *
 * Something stronger than all 151 (an easy thing to type by accident, or on
 * purpose for a one-off legendary) rounds to "above 100%", which is not a
 * real percentile of anything -- said plainly instead.
 */
function percentileText(pct) {
  if (pct == null) return "";
  if (pct >= 0.5) {
    const n = Math.round(pct * 100);
    return n >= 100 ? "higher than every one of them" : `above ${n}% of them`;
  }
  const n = Math.round((1 - pct) * 100);
  return n >= 100 ? "lower than every one of them" : `below ${n}% of them`;
}

/**
 * One stat's bar: the cohort's whole range as the track, the middle 80% of it
 * shaded, the median ticked, this value's marker on top -- and, if the
 * species has a type with enough of its own Pokemon to say something about,
 * a small mark for where that type usually sits.
 *
 * A number on its own ("Attack 130") tells a first-timer nothing. The same
 * number sitting past the end of the shaded part tells them everything.
 */
/**
 * `opts.onChange(v)`, when given, makes the bar itself draggable: click or
 * drag anywhere on the track to set the stat directly, an easier reach than
 * the number box's up/down arrows for a big change. The marker moves live
 * during the drag without a full re-render (that would tear out the pointer
 * capture on the very element being dragged); `opts.onCommit()` fires once
 * on release, for whatever depends on the final value (the total, the verdict).
 */
function statBar(band, value, typeMarks, opts = {}) {
  const marks = (typeMarks || []).filter(Boolean);
  const lo = Math.min(band.min, ...marks.map((t) => t.min));
  const hi = Math.max(band.max, value, ...marks.map((t) => t.max));
  const at = (v) => ((v - lo) / Math.max(1, hi - lo)) * 100;
  const youMarker = el("div", { class: "statyou", style: `left:${at(value)}%` });
  const bar = el("div", { class: "statbar" + (opts.onChange ? " live" : "") },
    el("div", { class: "statband", style: `left:${at(band.lo)}%;width:${Math.max(1, at(band.hi) - at(band.lo))}%` }),
    el("div", { class: "statmid", style: `left:${at(band.mid)}%` }),
    youMarker);
  for (const t of marks) {
    bar.append(el("div", {
      class: "stattype", style: `left:${at(t.mid)}%;background:${t.color}`,
      title: `${t.type}: usually around ${t.mid} here`,
    }));
  }

  if (opts.onChange) {
    const valueFromEvent = (ev) => {
      const rect = bar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      return Math.round(Math.max(0, Math.min(255, lo + frac * (hi - lo))));
    };
    let dragging = false;
    const move = (ev) => {
      const v = valueFromEvent(ev);
      youMarker.style.left = Math.max(0, Math.min(100, at(v))) + "%";
      opts.onChange(v);
    };
    bar.addEventListener("pointerdown", (ev) => {
      dragging = true;
      try { bar.setPointerCapture(ev.pointerId); } catch { /* synthetic event, no capture */ }
      move(ev);
    });
    bar.addEventListener("pointermove", (ev) => { if (dragging) move(ev); });
    const stop = () => { if (dragging) { dragging = false; opts.onCommit?.(); } };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
  }
  return bar;
}

/* ----------------------------------------------------------------- art -- */

// A species' battle art, in the same shape the sprite helpers already take:
// what the user imported, or the vanilla pic they picked, or nothing.
function monArt(m, slot) {
  const a = m._art?.[slot];
  if (!a) return null;
  if (a.source === "custom") return { key: artKey("ownmon" + slot, a), ...a };
  const bank = slot === "back" ? GAME?.monBack : GAME?.monFront;
  const pic = bank?.[a.id];
  return pic ? { key: slot + ":" + a.id, ...pic } : null;
}

// Where an imported picture ships inside the zip.
const monArtFile = (m, slot) =>
  "art/" + (m.id || idFromName(monName(m))).toLowerCase() + "_" + slot + ".png";

/**
 * The species records and PNGs an export has to carry for the art.
 *
 * Same contract as customSpriteRecords: authored here, collected at emit
 * time, so nothing in P.entries has to hold bytes.
 */
function monArtFiles() {
  const out = [];
  for (const m of allMons()) {
    for (const slot of ["front", "back"]) {
      const a = m._art?.[slot];
      if (a?.source === "custom" && a.png) out.push({ name: monArtFile(m, slot), bytes: base64Bytes(a.png) });
    }
    const ic = m._art?.icon;
    if (ic?.source === "custom" && ic.png) out.push({ name: monArtFile(m, "icon"), bytes: base64Bytes(ic.png) });
    const ow = m._art?.overworld;
    if (ow?.source === "custom" && ow.png) out.push({ name: monArtFile(m, "overworld"), bytes: base64Bytes(ow.png) });
  }
  return out;
}

/**
 * The `sprites:register` records a species' own walking sheets need.
 *
 * Same shape and reasoning as customSpriteRecords (npc.js): the picture is
 * authored here, under the species, but the engine only knows sprites as
 * their own registry -- so this is what turns m._art.overworld into
 * something main.lua can point an NPC's `sprite` field at (step 7).
 */
function monOverworldSpriteRecords() {
  const out = [];
  for (const m of allMons()) {
    const a = m._art?.overworld;
    if (a?.source !== "custom") continue;
    const data = {
      image: a.file, frames: a.frames, walker: !!a.walker,
      frameWidth: a.frameW, frameHeight: a.frameH,
    };
    if (a.anchorX !== undefined) data.anchorX = a.anchorX;
    if (a.anchorY !== undefined) data.anchorY = a.anchorY;
    if (a.trueColor) data.trueColor = true;
    out.push({ id: monOverworldSpriteId(m), data });
  }
  return out;
}

/**
 * Fold the art answers into each species record just before it is emitted.
 *
 * spriteFront/spriteBack are required fields, so a record with no picture at
 * all still has to name one: it borrows the vanilla path it was copied from,
 * or MISSINGNO's, rather than exporting an empty string the engine would
 * choke on.
 */
function syncMonArt() {
  for (const m of allMons().concat(P.monDraft ? [P.monDraft] : [])) {
    for (const slot of ["front", "back"]) {
      const key = slot === "front" ? "spriteFront" : "spriteBack";
      const a = m._art?.[slot];
      if (a?.source === "custom") { m.data[key] = monArtFile(m, slot); continue; }
      if (a?.source === "game") {
        const rec = GAME?.pokemon?.[a.id];
        if (rec?.[key]) { m.data[key] = rec[key]; continue; }
      }
      if (!m.data[key]) m.data[key] = "";
    }
    const ic = m._art?.icon;
    if (ic?.source === "custom") m.data.icon = { image: monArtFile(m, "icon"), frames: 2 };
    else if (ic?.source === "game") m.data.icon = ic.id;
    else delete m.data.icon;
    if (m._art?.front?.trueColor || m._art?.back?.trueColor) m.data.trueColor = true;
    else delete m.data.trueColor;

    // Anything already standing on a map copied the sprite id at the moment it
    // was placed. Changing the appearance afterwards has to follow it there,
    // or a species that was placed as a Monster and later dressed as a Snorlax
    // exports still wearing the Monster.
    if (m._art?.overworld) {
      const sprite = monOverworldSpriteId(m);
      for (const f of monEncountersFor(m)) f.npc.sprite = sprite;
    }
  }
}

/* ------------------------------------------------------------- the tab -- */

function monStep(host, n, title, note) {
  const wrap = el("div", { class: "step" + (n === null ? " todo" : "") });
  wrap.append(el("h3", {},
    el("span", { class: "n" }, n === null ? "—" : n + "."),
    title,
    note ? el("span", { class: "said" }, note) : null));
  const body = el("div", { class: "body" });
  wrap.append(body);
  host.append(wrap);
  return body;
}

function renderMonTab() {
  const host = $("#monSteps");
  if (!host) return;
  host.textContent = "";

  const m = curMon();
  $("#monTitle").innerHTML = m
    ? "Pokemon <b>" + escapeText(monName(m)) + "</b>" + (isMonDraft(m) ? " — not added yet" : "")
    : "Pokemon";

  monBar(host, m);
  if (!m) {
    host.append(el("div", { class: "step" },
      el("div", { class: "empty" },
        allMons().length
          ? "Pick one from the list above, or press New."
          : "No Pokemon in this mod yet. Press New to invent one, or Copy to start from one of the game's own.")));
    return;
  }

  stepMonName(host, m);
  stepMonLook(host, m);
  stepMonStats(host, m);
  stepMonMoves(host, m);
  stepMonEvo(host, m);
  stepMonCry(host, m);
  stepMonSpawn(host, m);
  stepMonFooter(host, m);
}

function guardMonDraft(proceed) {
  guardDraftReplace(P.monDraft,
    { label: "“" + monName(P.monDraft) + "”", why: P.monDraft && monDraftBlocker(P.monDraft), add: () => addMonDraft(P.monDraft) },
    proceed);
}

function monBar(host, cur) {
  const bar = el("div", { class: "workbar" });
  bar.append(el("button", { class: "fixed", onclick: () => guardMonDraft(copyMonDialog) }, "Copy"));
  bar.append(el("button", { class: "fixed", onclick: () => guardMonDraft(() => {
    P.monDraft = blankMon();
    P.sel.mon = "draft";
    touch(); renderMonTab();
  }) }, "New"));

  const rows = allMons();
  if (rows.length || P.monDraft) {
    const sel = el("select", {
      onchange: (e) => {
        P.sel.mon = e.target.value || null;
        renderMonTab();
      },
    },
      el("option", { value: "" }, `— ${rows.length} in this mod —`),
      P.monDraft ? el("option", { value: "draft", selected: cur === P.monDraft },
        (monName(P.monDraft) === "(unnamed)" ? "new Pokemon" : monName(P.monDraft)) + "  (not added yet)") : null,
      ...rows.map((r) => el("option", { value: r._uid, selected: r === cur },
        monName(r) + "  —  #" + (r.data.dex || "?"))));
    bar.append(sel);
  }

  if (isMonDraft(cur)) {
    const why = monDraftBlocker(cur);
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", {
      id: "monAddDraft", class: "primary fixed", disabled: !!why, title: why || "",
      onclick: () => addMonDraft(cur),
    }, "Add to the mod"));
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => discardMonDraft(cur) }, "Discard"));
  } else if (cur) {
    // Same spot "Add to the mod" sat in before it was added -- a quiet pulse
    // once editing pauses (flashUpdated, driven by touch()'s own debounce),
    // not a button, since edits already apply live and autosave as they're
    // made and there is nothing here to actually commit.
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("span", { id: "monUpdated", class: "updated-flash" }, "Updated"));
    // Same top-right spot NPC/Items/Moves already put theirs -- used to live
    // at the bottom of a long form (stepMonFooter), which is the one thing
    // about this workspace that wasn't like the other three converted ones.
    bar.append(el("div", { style: "flex:1" }));
    bar.append(el("button", { class: "fixed danger", onclick: () => deleteMon(cur) }, "Delete " + monName(cur)));
  }

  host.append(bar);
}

const monDraftBlocker = (m) => !m.data.name ? "Give it a name first." : null;

function syncMonDraftReady(m) {
  if (!isMonDraft(m)) return;
  const why = monDraftBlocker(m);
  const b = $("#monAddDraft");
  if (b) { b.disabled = !!why; b.title = why || ""; }
}

function addMonDraft(m) {
  // The pokemon registry lists `id` as a required DATA field, separate from
  // the id this record is registered under -- moves and items already sync
  // this at commit time (move.js's addMoveDraft, item.js), species never
  // did, so every custom Pokemon shipped with it silently missing.
  m.data.id = m.id;
  P.entries.push(m);
  P.monDraft = null;
  P.sel.mon = m._uid;
  touch(); renderAll(); showContentSub("pokemon");
  toast(monName(m) + " added");
}

function discardMonDraft(m) {
  if (!confirm("Throw this one away?")) return;
  P.monDraft = null; P.sel.mon = null;
  touch(); renderMonTab();
}

function deleteMon(m) {
  if (!confirm(`Delete ${monName(m)}?`)) return;
  P.entries = P.entries.filter((e) => e !== m);
  P.sel.mon = null;
  touch(); renderAll();
}

/* --------------------------------------------------------------- 1. name -- */

function stepMonName(host, m, opts) {
  const body = monStep(host, 1, "Name", m.id ? "#" + (m.data.dex || "?") + "  " + m.id : null);
  const idLine = el("div", { class: "hint" });

  // Nested (an evolution row customizing its target) means m is not the
  // species this page is actually about, so the page title stays alone --
  // only the top-level call is allowed to rewrite #monTitle.
  const retitle = () => {
    if (opts?.nested) return;
    const t = $("#monTitle");
    if (t) t.innerHTML = "Pokemon <b>" + escapeText(monName(m)) + "</b>"
      + (isMonDraft(m) ? " — not added yet" : "");
  };

  body.append(el("input", {
    value: m.data.name || "", placeholder: "e.g. Sparkmouse", maxlength: 10,
    oninput: (e) => {
      const was = m.id;
      m.data.name = e.target.value.toUpperCase();
      m.id = idFromName(m.data.name);
      m.data.id = m.id;
      if (was && was !== m.id) renameMonRefs(was, m.id);
      // Made by "＋ a new Pokemon" in someone else's evolution step: the row
      // that sent us here is still pointing at nothing, so fill it in as the
      // name appears rather than making them go back and choose it.
      const back = evoRowFor(m);
      if (back) back.species = m.id;
      idLine.textContent = m.id ? `The engine will know it as ${m.id}.` : "";
      touch(); syncMonDraftReady(m); retitle();
    },
  }));
  idLine.textContent = m.id ? `The engine will know it as ${m.id}.` : "";
  body.append(idLine);
  body.append(el("p", { class: "hint" },
    "Ten letters is the most the game's name box fits, so that is the limit here too."));

  body.append(el("label", {}, "Pokedex number"));
  body.append(el("input", {
    type: "number", min: "1", max: "255", value: String(m.data.dex || ""),
    oninput: (e) => { m.data.dex = Number(e.target.value) || 0; touch(); },
  }));
  body.append(el("p", { class: "hint" },
    "The 151 already hold 1–151, so a new one starts at 152. Reusing a number the game "
    + "already has puts two Pokemon in one Pokedex slot."));
}

/**
 * Follow a rename everywhere the old id was written down.
 *
 * The id is derived from the name, so it changes mid-typing -- and by then it
 * may already be sitting in another species' evolution row or in a map's wild
 * table. Leaving those pointing at an id nothing answers to is the kind of
 * break that only shows up as a crash on load.
 */
function renameMonRefs(from, to) {
  if (!from || !to || from === to) return;
  for (const e of P.entries) {
    if (e.registry === "pokemon") {
      for (const ev of e.data?.evolutions || []) if (ev.species === from) ev.species = to;
    }
    if (e.registry === "encounters") {
      for (const where of ["grass", "water"]) {
        for (const s of e.data?.[where]?.slots || []) if (s.species === from) s.species = to;
      }
    }
  }
  for (const ev of P.monDraft?.data?.evolutions || []) if (ev.species === from) ev.species = to;
}

/* --------------------------------------------------------------- 2. look -- */

function stepMonLook(host, m) {
  const front = monArt(m, "front"), back = monArt(m, "back");
  const body = monStep(host, 2, "How it looks", front ? null : "no front picture yet");

  body.append(el("p", { class: "hint" },
    "The front picture is the one that matters — it is what the player stares at for a whole "
    + "battle. Start from one of the game's own and paint over it: pick it here, press Export, "
    + "and the real PNG lands in your downloads at the size the engine wants."));

  monArtSlot(body, m, "front", {
    title: "Front picture",
    hint: "Seen when the player meets it. The game's own are up to 56 px square.",
  });
  monArtSlot(body, m, "back", {
    title: "Back picture",
    hint: "Seen over the player's shoulder once it is theirs. The game's own are 32 px square "
      + "and drawn at twice that, which is why they look soft.",
  });

  if (front || back) {
    body.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:14px 0" }));
    body.append(el("div", { class: "who" }, "In a battle"));
    body.append(el("p", { class: "hint" },
      "Both pictures on the screen they end up on, at the size, place and colours the engine draws "
      + "them in. The dashed box is a slot with nothing in it yet."));
    body.append(battleMockPanel({ facing: front, back, name: monName(m), scale: 2 }));
  }

  body.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:14px 0" }));
  monIconSlot(body, m);
}

/* --------------------------------------------- the overworld appearance -- */

/*
   Gen 1 has no walking sprite for a SPECIES -- but it does have eight
   Pokemon-shaped overworld sprites, the ones the game itself uses for the
   things that stand on a map and fight you: the legendary birds, Snorlax
   asleep in the road, the Safari Zone Seel, a fossil on the ground. A species
   put in the world can wear one of those, or a sheet of its own.

   This lives with the fixed encounter in step 7 rather than with the battle
   art in step 2, because it is only ever about standing on a map -- a species
   that never leaves the grass has no use for it.
*/
const MON_OVERWORLD_SPRITES = [
  ["SPRITE_BIRD", "Bird"],
  ["SPRITE_MONSTER", "Monster"],
  ["SPRITE_FAIRY", "Fairy"],
  ["SPRITE_SEEL", "Seel"],
  ["SPRITE_SNORLAX", "Snorlax"],
  ["SPRITE_BOULDER", "Boulder"],
  ["SPRITE_FOSSIL", "Fossil"],
  ["SPRITE_POKE_BALL", "Poke Ball"],
];

// Whatever the overworld slot points at, in the shape owPreview and the
// thumbnails take -- one of the game's own sheets, or an imported one.
function monOverworldArt(m) {
  const a = m._art?.overworld;
  if (!a) return null;
  if (a.source === "custom") return { key: artKey("ownmonow", a), ...a };
  const sheet = GAME?.spriteSheets?.[a.id];
  return sheet ? { key: "game:" + a.id, ...sheet } : null;
}

/**
 * The sprite id this species stands under on a map.
 *
 * One of the game's own is used by name -- nothing is registered for it,
 * because it already exists. Only an imported sheet needs an id of its own,
 * and it dodges a collision the same way an NPC's customSpriteId does.
 */
function monOverworldSpriteId(m) {
  const a = m._art?.overworld;
  if (a?.source === "game") return a.id;
  const base = "SPRITE_" + (m.id || idFromName(monName(m)));
  return GAME?.spriteSheets?.[base] ? base + "_MOD" : base;
}

function monOverworldSlot(host, m) {
  const cur = m._art?.overworld;
  const art = monOverworldArt(m);

  host.append(el("div", { class: "who", style: "margin-top:4px" }, "What it looks like on the map"));
  host.append(el("p", { class: "hint" },
    "The game's own Pokemon-shaped overworld sprites are below — these are what the birds, Snorlax "
    + "and the Safari Zone Seel actually use. Pick one, or bring a sheet of your own."));

  if (art) host.append(owPreview(art));

  const sheets = MON_OVERWORLD_SPRITES.filter(([id]) => GAME?.spriteSheets?.[id]);
  if (sheets.length) {
    const grid = el("div", { class: "spritegrid" });
    for (const [id, label] of sheets) {
      const p = GAME.spriteSheets[id];
      const fh = p.frames ? Math.round(p.h / p.frames) : p.h;
      grid.append(el("div", {
        class: "spritepick" + (cur?.source === "game" && cur.id === id ? " sel" : ""),
        onclick: () => { (m._art ||= {}).overworld = { source: "game", id }; touch(); renderMonTab(); },
      },
        artCanvas("game:" + id, p.png, 0, 0, p.w, fh, 2),
        el("span", {}, label)));
    }
    host.append(grid);
  }

  host.append(el("div", { class: "row", style: "margin:8px 0" },
    el("button", { onclick: () => importMonOverworld(m) },
      cur?.source === "custom" ? "Re-import" : "Import custom spritesheet"),
    cur ? el("button", { class: "danger",
      onclick: () => { delete m._art.overworld; touch(); renderMonTab(); } }, "Clear") : null));
}

function importMonOverworld(m) {
  spriteStudio({
    title: "Import an overworld sprite sheet",
    mode: "strip",
    fileBase: (m.id || "mon").toLowerCase() + "_overworld",
    hint: "Any sheet, any layout — a grid, a packed atlas, a single row. Pick the file and Oak's Lab "
      + "finds the frames, then you say which is which. One pose is enough for something that just "
      + "stands there; all six lets it walk.",
    onDone: (art) => {
      (m._art ||= {}).overworld = { source: "custom", ...art, file: monArtFile(m, "overworld") };
      touch(); renderMonTab();
    },
  });
}

function monArtSlot(host, m, slot, o) {
  const art = monArt(m, slot);
  const a = m._art?.[slot];
  artSlot(host, {
    title: o.title, hint: o.hint, art, scale: 1,
    label: !a ? "none" : a.source === "custom" ? "imported" : a.id,
    onPickGame: () => pickMonPicDialog(m, slot),
    onImport: () => spriteStudio({
      title: `Import a ${slot} picture`,
      mode: "single",
      battle: slot === "front" ? "facing" : "back",
      who: monName(m),
      fileBase: (m.id || "mon").toLowerCase() + "_" + slot,
      hint: "One picture. Any size works — drag a box on the sheet to crop out just the part you want.",
      onDone: (art2) => { (m._art ||= {})[slot] = { source: "custom", ...art2 }; touch(); renderMonTab(); },
    }),
    onExport: art ? () => exportArt(art, (m.id || "mon").toLowerCase() + "_" + slot) : null,
    onClear: a ? () => { delete m._art[slot]; touch(); renderMonTab(); } : null,
  });
}

function pickMonPicDialog(m, slot) {
  const bank = slot === "back" ? GAME?.monBack : GAME?.monFront;
  const ids = Object.keys(bank || {}).sort();
  if (!ids.length) { toast("No Pokemon pictures in this game data — regenerate it", true); return; }

  const body = el("div", {});
  const grid = el("div", { class: "spritegrid" });
  const fill = (needle) => {
    grid.textContent = "";
    for (const id of ids) {
      if (needle && !id.toLowerCase().includes(needle)) continue;
      const p = bank[id];
      grid.append(el("div", {
        class: "spritepick" + (m._art?.[slot]?.id === id ? " sel" : ""),
        onclick: () => {
          (m._art ||= {})[slot] = { source: "game", id };
          touch(); closeDialog(); renderMonTab();
        },
      },
        artCanvas(slot + ":" + id, p.png, 0, 0, p.w, p.h, 1),
        el("span", {}, id)));
    }
    if (!grid.children.length) grid.append(el("div", { class: "empty" }, "nothing matches"));
  };
  body.append(el("input", {
    type: "search", placeholder: `search ${ids.length}…`,
    oninput: (e) => fill(e.target.value.trim().toLowerCase()),
  }));
  body.append(el("p", { class: "hint" },
    "Pick one to use as-is, or pick it and press Export on the slot to get the PNG and paint over it."));
  fill("");
  body.append(grid);
  dialog(`Pick a ${slot} picture`, body);
}

/**
 * The party-menu icon.
 *
 * Gen 1 Pokemon have no overworld sprite -- they are never on the map -- so
 * the honest equivalent is the little animated thing in the party list. Says
 * so rather than offering a walking sheet that would go nowhere.
 */
function monIconSlot(host, m) {
  const art = GAME?.iconArt || {};
  const names = Object.keys(art).sort();
  const cur = m._art?.icon;

  host.append(el("div", { class: "who" }, "Menu icon"));
  host.append(el("p", { class: "hint" },
    "The little animated shape in the party and Pokedex lists — one of "
    + (names.length || "a few") + " the game shares between all 151, or a two-frame sprite of your "
    + "own. (What it looks like standing on a map, if it ever does, is step 7.)"));

  if (cur?.source === "custom") {
    host.append(el("div", { class: "row", style: "align-items:center;gap:10px" },
      spriteThumb({ key: artKey("ownicon", cur), ...cur }, 3, 0),
      el("span", { class: "hint" }, "your own icon")));
  }

  host.append(el("div", { class: "row", style: "margin:8px 0" },
    el("button", { onclick: () => importMonIcon(m) }, cur?.source === "custom" ? "Re-import" : "Import sprite"),
    cur ? el("button", { class: "danger",
      onclick: () => { delete m._art.icon; touch(); renderMonTab(); } }, "Clear icon") : null));

  if (!names.length) {
    host.append(el("p", { class: "hint warn" }, "No shared icons in this game data — regenerate it to pick one."));
    return;
  }
  const grid = el("div", { class: "spritegrid" });
  for (const n of names) {
    const p = art[n];
    grid.append(el("div", {
      class: "spritepick" + (cur?.source === "game" && cur.id === n ? " sel" : ""),
      onclick: () => { (m._art ||= {}).icon = { source: "game", id: n }; touch(); renderMonTab(); },
    },
      artCanvas("icon:" + n, p.png, 0, 0, Math.min(p.w, 16), Math.min(p.h, 16), 2),
      el("span", {}, n)));
  }
  host.append(grid);
}

function importMonIcon(m) {
  spriteStudio({
    title: "Import a menu icon",
    mode: "icon",
    fileBase: (m.id || "mon").toLowerCase() + "_icon",
    hint: "Two frames — what it looks like on each half of its blink/bob cycle in the party and Pokedex "
      + "lists. Any size works — drag a box on the sheet to crop out just the part you want.",
    onDone: (art) => { (m._art ||= {}).icon = { source: "custom", ...art }; touch(); renderMonTab(); },
  });
}

/* ------------------------------------------------------- 3. type & stats -- */

function stepMonStats(host, m) {
  const s = m.data.baseStats;
  const total = monBst(s);
  const body = monStep(host, 3, "Type and stats", "total " + total);

  /* --- types --- */
  body.append(el("label", {}, "Type"));
  const types = m.data.types || (m.data.types = ["NORMAL"]);
  const typeRow = el("div", { class: "grid2" });
  const typeSel = (i) => refSelect("type_chart",
    () => types[i] || "",
    (v) => {
      if (i === 0) types[0] = v || "NORMAL";
      else if (v) types[1] = v; else types.length = 1;
      renderMonTab();
    },
    { blank: i === 0 ? "— choose —" : "— none (one type) —", noFilter: true });
  typeRow.append(typeSel(0), typeSel(1));
  body.append(typeRow);
  body.append(el("p", { class: "hint" },
    "A second type is optional. Gen 1 stores both even when they match, so leaving the second "
    + "empty is what makes it a single-type Pokemon."));

  /* --- the meter --- */
  const cohort = monCohort(m);
  const band = cohortBand(cohort);
  // Up to two colours, one per type -- the same colours the Maps tab already
  // uses for warps and objects, borrowed here because they read as distinct
  // from the meter's own red-and-grey without adding a third palette.
  const TYPE_MARK_COLORS = ["var(--warp)", "var(--obj)"];
  const typeBands = types
    .map((t, i) => (t ? { type: t, color: TYPE_MARK_COLORS[i], b: typeBand(t) } : null))
    .filter((t) => t?.b);
  body.append(el("h2", { style: "margin-top:16px" }, "Base stats"));

  if (!band) {
    body.append(el("p", { class: "hint warn" },
      "Load game data to see how these compare with the game's own Pokemon."));
  } else {
    body.append(el("p", { class: "hint" },
      `Measured against the ${band.n} of the game's Pokemon that `
      + (cohort === "evolves" ? "still evolve into something" : "are as grown-up as they get")
      + " — which is what this one is, going by step 5. The shaded part of each bar is where "
      + "most of them sit; the notch is the middle one."));
  }
  if (typeBands.length) {
    const legend = [];
    typeBands.forEach((t, i) => {
      if (i) legend.push(" and ");
      legend.push(el("span", { style: `color:${t.color};font-weight:700` }, t.type));
    });
    body.append(el("p", { class: "hint" },
      typeBands.length > 1 ? "The small marks on each bar show where " : "The small mark on each bar shows where ",
      ...legend,
      " Pokemon usually sit for that stat — a Rock-type's ordinary defense, for instance, "
      + "reads as unremarkable there and high everywhere else."));
  }

  for (const k of MON_STATS) {
    const row = el("div", { class: "statrow" });
    row.append(el("span", { class: "statname" }, MON_STAT_LABEL[k]));
    const input = el("input", {
      type: "number", min: "1", max: "255", value: String(s[k] ?? 0), class: "statnum",
      oninput: (e) => {
        s[k] = Math.max(0, Math.min(255, Number(e.target.value) || 0));
        touch(); renderMonTab();
      },
    });
    row.append(input);
    if (band) {
      let verdictSpan = null;
      const setLive = (v) => {
        s[k] = v;
        input.value = String(v);
        if (verdictSpan) {
          const vv = verdictOf(percentileIn(band[k].sorted, v));
          verdictSpan.textContent = vv.word;
          verdictSpan.className = "statword " + vv.cls;
        }
        touch();
      };
      row.append(statBar(band[k], s[k] || 0, typeBands.map((t) => ({ ...t.b[k], type: t.type, color: t.color })),
        { onChange: setLive, onCommit: renderMonTab }));
      const v = verdictOf(percentileIn(band[k].sorted, s[k] || 0));
      verdictSpan = el("span", { class: "statword " + v.cls }, v.word);
      row.append(verdictSpan);
    }
    body.append(row);
  }

  if (band) {
    const pct = percentileIn(band.total.sorted, total);
    const v = verdictOf(pct);
    const near = [...band.rows]
      .sort((a, b) => Math.abs(monBst(a.baseStats) - total) - Math.abs(monBst(b.baseStats) - total))
      .slice(0, 3)
      .map((r) => `${r.name || r.id} ${monBst(r.baseStats)}`);
    body.append(el("p", { class: "hint " + (v.cls === "good" ? "" : v.cls), style: "margin-top:10px" },
      `Total ${total} — ${v.word} for this kind of Pokemon, ${percentileText(pct)}. `
      + `Nearest: ${near.join(", ")}.`));
    if (total > band.total.max) {
      body.append(el("p", { class: "hint bad" },
        `Nothing in the game reaches ${total}; the strongest is ${band.total.max}. Fine if you meant `
        + "it, but nothing the player already owns will keep up."));
    }
  }

  /* --- the rest --- */
  body.append(el("h2", { style: "margin-top:16px" }, "The other numbers"));
  const grid = el("div", { class: "grid2" });
  const num = (label, key, min, max, hint) => {
    const wrap = el("div", {});
    wrap.append(el("label", {}, label));
    wrap.append(el("input", {
      type: "number", min: String(min), max: String(max), value: String(m.data[key] ?? 0),
      oninput: (e) => { m.data[key] = Math.max(min, Math.min(max, Number(e.target.value) || 0)); touch(); },
    }));
    wrap.append(el("div", { class: "hint" }, hint));
    return wrap;
  };
  grid.append(num("Catch rate", "catchRate", 0, 255, "255 is a Caterpie, 3 is a legendary."));
  grid.append(num("Base experience", "baseExp", 0, 255, "How much beating it is worth."));
  body.append(grid);

  body.append(el("label", {}, "How fast it levels"));
  body.append(refSelect("growth_rates",
    () => m.data.growthRate || "",
    (v) => { m.data.growthRate = v; }, { noFilter: true }));
}

/* -------------------------------------------------------------- 4. moves -- */

/**
 * "None of these is what I wanted" — the button that opens the Moves tab.
 *
 * Everything a species can know has to already exist, which means the honest
 * answer to "I want it to have a move of its own" was previously: leave, build
 * one, come back, and find it among 166. This carries the intent across
 * instead, and src/move.js hands the finished move back to this slot.
 */
function inventMoveButton(m, slot, level) {
  if (typeof inventMoveFor !== "function") return null;
  return el("button", { class: "fixed", onclick: () => inventMoveFor(m, slot, level) }, "+ Invent one");
}

function stepMonMoves(host, m) {
  const starting = m.data.level1Moves || (m.data.level1Moves = []);
  const learn = m.data.learnset || (m.data.learnset = []);
  const body = monStep(host, 4, "Moves", `${starting.length} to start, ${learn.length} learned`);

  body.append(el("div", { class: "who" }, "Knows from the start"));
  body.append(el("p", { class: "hint" },
    "Up to four. A Pokemon caught or hatched at any level knows these, plus anything from the "
    + "list below that it would already have reached."));
  for (let i = 0; i < starting.length; i++) {
    body.append(el("div", { class: "row", style: "margin-bottom:4px" },
      refSelect("moves", () => starting[i], (v) => { starting[i] = v; touch(); }, { noFilter: true }),
      el("button", { class: "fixed danger", onclick: () => { starting.splice(i, 1); touch(); renderMonTab(); } }, "×")));
  }
  if (starting.length < 4) {
    body.append(el("div", { class: "row", style: "flex-wrap:wrap" },
      el("button", { class: "fixed", onclick: () => { starting.push(""); touch(); renderMonTab(); } },
        "+ Add a starting move"),
      inventMoveButton(m, "start")));
  }

  body.append(el("div", { class: "who", style: "margin-top:14px" }, "Learns as it levels"));
  body.append(el("p", { class: "hint" },
    "Level, then the move. Order does not matter — the engine reads the level off each row."));
  const sorted = [...learn].sort((a, b) => (a.level || 0) - (b.level || 0));
  for (const rowData of sorted) {
    const i = learn.indexOf(rowData);
    body.append(el("div", { class: "row", style: "margin-bottom:4px" },
      el("input", {
        type: "number", min: "2", max: "100", value: String(rowData.level || 2), class: "fixed",
        style: "flex:0 0 74px",
        oninput: (e) => { rowData.level = Math.max(2, Math.min(100, Number(e.target.value) || 2)); touch(); },
      }),
      refSelect("moves", () => rowData.move || "", (v) => { rowData.move = v; touch(); }, { noFilter: true }),
      el("button", { class: "fixed danger", onclick: () => { learn.splice(i, 1); touch(); renderMonTab(); } }, "×")));
  }
  const nextLevel = Math.min(100, learn.reduce((n, r) => Math.max(n, r.level || 0), 1) + 6);
  body.append(el("div", { class: "row", style: "flex-wrap:wrap" },
    el("button", {
      class: "fixed",
      onclick: () => { learn.push({ level: nextLevel, move: "" }); touch(); renderMonTab(); },
    }, "+ Add a learned move"),
    inventMoveButton(m, "learn", nextLevel)));

  body.append(el("p", { class: "hint" },
    "“Invent one” opens the Moves tab with a blank move waiting. Name it, and it comes straight "
    + "back here in the slot you pressed — you do not have to go looking for it afterwards."));

  /* TMs are a long list of tickboxes nobody wants unfolded by default. */
  const tm = m.data.tmhm || (m.data.tmhm = []);
  const det = el("details", { style: "margin-top:14px" });
  det.append(el("summary", { style: "cursor:pointer;color:var(--dim);font-size:14px" },
    `Which TMs and HMs it can be taught (${tm.length} ticked)`));
  const moves = allIds("moves") || [];
  if (!moves.length) {
    det.append(el("p", { class: "hint" }, "Load game data to pick from the move list."));
  } else {
    const grid = el("div", { class: "tmgrid" });
    for (const o of moves) {
      const on = tm.includes(o.id);
      grid.append(el("label", { class: "tmpick" },
        el("input", {
          type: "checkbox", checked: on,
          onchange: (e) => {
            if (e.target.checked) { if (!tm.includes(o.id)) tm.push(o.id); }
            else m.data.tmhm = tm.filter((x) => x !== o.id);
            touch();
          },
        }),
        o.name || o.id));
    }
    det.append(grid);
  }
  body.append(det);
}

/* ---------------------------------------------------------- 5. evolution -- */

/**
 * The evolution step, and the chain that grows out of it.
 *
 * "and then it becomes a third one" is the point where a first-timer usually
 * gives up and goes to make a second record by hand, so the target dropdown
 * carries a "make it a new Pokemon" option: pressing that parks the current
 * draft in the mod, opens a fresh one, and writes the link between them.
 */
// Which evolution rows have their "customize the target" panel open right
// now. Render-only state, the same idea as owState in npc.js -- it resets on
// reload, and nothing downstream needs to know about it.
const evoExpanded = new Set();

// The target of an evolution row, but only if it is something this mod owns
// (an added species, or the species currently being drafted) -- editing one
// of the game's own 151 in place from here isn't a thing this screen allows.
function evoTargetRecord(ev) {
  if (!ev?.species) return null;
  return allMons().find((x) => x.id === ev.species)
    || (P.monDraft?.id === ev.species ? P.monDraft : null);
}

function stepMonEvo(host, m) {
  const evos = m.data.evolutions || (m.data.evolutions = []);
  const body = monStep(host, 5, "Evolution", evos.length ? null : "does not evolve");

  body.append(monChainView(m));

  if (!evos.length) {
    body.append(el("p", { class: "hint" },
      "Nothing yet, so this counts as fully grown — which is what step 3 measures its stats "
      + "against. Add a row and that comparison moves with it."));
  }

  for (let i = 0; i < evos.length; i++) {
    const ev = evos[i];
    const card = el("div", { class: "evorow" });
    card.append(el("label", {}, "How"));
    card.append(refSelect("evolution_methods",
      () => ev.method || "",
      (v) => { ev.method = v; renderMonTab(); }, { noFilter: true, blank: "— choose —" }));

    if (ev.method === "ITEM") {
      card.append(el("label", {}, "With which item"));
      card.append(refSelect("items", () => ev.item || "", (v) => { ev.item = v; touch(); }));
      card.append(el("p", { class: "hint" }, "Gen 1 still stores a level on a stone evolution; 1 is what the game uses."));
      if (ev.level == null) ev.level = 1;
    } else if (ev.method === "TRADE") {
      if (ev.level == null) ev.level = 1;
      card.append(el("p", { class: "hint" }, "Happens the moment it is traded, whatever level it is."));
    } else {
      card.append(el("label", {}, "At what level"));
      card.append(el("input", {
        type: "number", min: "2", max: "100", value: String(ev.level || 16),
        oninput: (e) => { ev.level = Math.max(2, Math.min(100, Number(e.target.value) || 16)); touch(); },
      }));
    }

    card.append(el("label", {}, "Into what"));
    card.append(monTargetSelect(m, ev));

    const target = evoTargetRecord(ev);
    if (target) {
      const open = evoExpanded.has(ev);
      card.append(el("button", {
        class: "fixed", style: "margin-top:8px",
        onclick: () => { if (open) evoExpanded.delete(ev); else evoExpanded.add(ev); renderMonTab(); },
      }, (open ? "▾ " : "▸ ") + "Customize " + monName(target)));

      if (open) {
        const nested = el("div", { class: "evo-nested" });
        stepMonName(nested, target, { nested: true });
        stepMonLook(nested, target);
        stepMonStats(nested, target);
        stepMonMoves(nested, target);
        card.append(nested);
      }
    }

    card.append(el("button", {
      class: "danger", style: "margin-top:8px",
      onclick: () => { evos.splice(i, 1); touch(); renderMonTab(); },
    }, "Remove this evolution"));
    body.append(card);
  }

  body.append(el("button", {
    style: "margin-top:8px",
    onclick: () => { evos.push({ method: "LEVEL", level: 16, species: "" }); touch(); renderMonTab(); },
  }, evos.length ? "+ Another evolution" : "+ It evolves"));
  if (evos.length > 1) {
    body.append(el("p", { class: "hint" },
      "More than one row is an Eevee: the game picks whichever condition is met first."));
  }
}

/**
 * The "into what" dropdown, with the escape hatch that makes a chain
 * possible: the last option invents the next species instead of asking the
 * user to have already made it.
 */
function monTargetSelect(m, ev) {
  const NEW = "__new__";
  const wrap = el("div", {});
  const options = allIds("pokemon") || [];
  const sel = el("select", {
    onchange: (e) => {
      if (e.target.value === NEW) { createNextMon(m, ev); return; }
      ev.species = e.target.value;
      touch(); renderMonTab();
    },
  });
  sel.append(el("option", { value: "" }, "— choose —"));
  sel.append(el("option", { value: NEW }, "＋ a new Pokemon (make it now)"));
  const v = ev.species || "";
  if (v && !options.some((o) => o.id === v)) sel.append(el("option", { value: v, selected: true }, v + "  (not in this game)"));
  appendIdOptions(sel, options, v);
  wrap.append(sel);
  return wrap;
}

/**
 * Add the current draft (so the link has something to point at), then open a
 * fresh one that inherits the things a next form almost always keeps.
 *
 * Stats deliberately do NOT carry over: a next form that is a copy of its
 * previous form is the one mistake this screen exists to catch, and step 3
 * will now be measuring it against the grown-up cohort instead.
 */
function createNextMon(m, ev) {
  if (isMonDraft(m)) {
    const why = monDraftBlocker(m);
    if (why) { toast(why, true); renderMonTab(); return; }
    P.entries.push(m); P.monDraft = null;
    spawnNextMon(m, ev);
    return;
  }
  // m is already a real record, so P.monDraft (if anything) is unrelated to
  // it -- an abandoned draft from something else entirely -- and about to be
  // overwritten by the new evolution target. Ask first.
  guardMonDraft(() => spawnNextMon(m, ev));
}

function spawnNextMon(m, ev) {
  const next = blankMon();
  next.data.types = [...(m.data.types || ["NORMAL"])];
  next.data.growthRate = m.data.growthRate;
  next.data.catchRate = m.data.catchRate;
  next.data.level1Moves = [...(m.data.level1Moves || [])];
  next.data.learnset = (m.data.learnset || []).map((r) => ({ ...r }));
  next.data.tmhm = [...(m.data.tmhm || [])];
  next.data.name = "";
  next.id = "";

  P.monDraft = next;
  P.sel.mon = "draft";
  // Remember which row sent us here BY POSITION, not by holding the row
  // object: the project is saved as JSON, so a live reference would come back
  // from a reload as a detached copy and the name would fill in a row nothing
  // reads. uid + index survives the round trip.
  ev.species = "";
  next._evoFrom = { uid: m._uid, at: m.data.evolutions.indexOf(ev) };
  touch(); renderAll(); renderMonTab();
  toast("Name the next form — the link back to " + monName(m) + " fills itself in");
}

// The evolution row that "＋ a new Pokemon" came from, or null if the record
// it pointed at has since been deleted or its rows reshuffled.
function evoRowFor(m) {
  const from = m?._evoFrom;
  if (!from) return null;
  const parent = allMons().find((x) => x._uid === from.uid);
  return parent?.data?.evolutions?.[from.at] || null;
}

/**
 * Draw the whole line, following links through the mod and the game.
 *
 * A chain is the one thing about a species you cannot read off its own
 * record: the previous form is somewhere else entirely. Capped at four hops
 * so a record that evolves into itself cannot hang the page.
 */
function monChainView(m) {
  const row = el("div", { class: "chain" });
  const find = (id) => allMons().find((x) => x.id === id)
    || (P.monDraft?.id === id ? P.monDraft : null)
    || GAME?.pokemon?.[id] || null;
  const evosOf = (rec) => (rec?.data?.evolutions ?? rec?.evolutions) || [];
  const idOf = (rec) => rec?.id || null;
  const label = (rec, id) => rec ? (rec.data?.name || rec.name || id) : id;
  const howOf = (ev) => ev.method === "ITEM" ? (ev.item || "an item")
    : ev.method === "TRADE" ? "trade"
    : "Lv " + (ev.level || "?");

  /* Walk BACK to the start of the line first. A record only knows what it
     turns into, so the previous form has to be found by asking everything
     else what it points at -- and without this the third form of a line looks
     like a lone Pokemon with no history. */
  const everything = () => [...allMons(), ...(P.monDraft ? [P.monDraft] : []),
    ...Object.values(GAME?.pokemon || {})];
  const parentOf = (id) => id
    ? everything().find((r) => evosOf(r).some((e) => e.species === id)) || null
    : null;

  let base = m, guard = 0;
  const backSeen = new Set([m.id].filter(Boolean));
  while (guard++ < 4) {
    const p = parentOf(idOf(base));
    if (!p || backSeen.has(idOf(p))) break;
    backSeen.add(idOf(p));
    base = p;
  }

  /* ...then draw forward from there, marking the one being edited. */
  let cur = base, hops = 0;
  const seen = new Set();
  const box = (rec, id) => el("span",
    { class: "chainbox" + (rec === m ? " on" : "") }, label(rec, id));
  row.append(box(base, idOf(base) || monName(base)));

  while (hops++ < 4) {
    const parts = evosOf(cur).filter((e) => e.species);
    if (!evosOf(cur).length) break;
    if (!parts.length) {
      row.append(el("span", { class: "chainarrow" }, "→"));
      row.append(el("span", { class: "chainbox ghost" }, "?"));
      break;
    }
    for (let i = 0; i < parts.length; i++) {
      const ev = parts[i];
      row.append(el("span", { class: "chainarrow" }, (i ? " / " : "") + howOf(ev) + " →"));
      row.append(box(find(ev.species), ev.species));
    }
    if (parts.length > 1 || seen.has(parts[0].species)) break;
    seen.add(parts[0].species);
    cur = find(parts[0].species);
    if (!cur) break;
  }
  return row;
}

/* ---------------------------------------------------------------- 6. cry -- */

/**
 * The cry.
 *
 * One sound per species, and Gen 1 uses the same one when it appears and when
 * it faints -- the engine bends the pitch rather than playing a second clip,
 * so there is no separate faint sound to set here. A new species borrows an
 * existing cry and shifts it, which is exactly what the `cries` registry's
 * {base, pitch, length} form is for.
 */
function stepMonCry(host, m) {
  const cry = m._cry || (m._cry = {});
  const summary = cry.file ? "imported: " + cry.name : cry.base ? "based on " + cry.base : "no cry yet";
  const body = monStep(host, 6, "Its cry", summary);

  body.append(el("p", { class: "hint" },
    "The noise it makes when it appears. Gen 1 plays the same one when it faints, just bent "
    + "downward, so there is no second sound to pick. Every cry is built out of the ROM's own "
    + "sound data, so a new one starts from an existing cry and shifts it — or, below, is a real "
    + "recording instead."));

  body.append(el("label", {}, "Start from"));
  body.append(refSelect("cries", () => cry.base || "", (v) => {
    cry.base = v;
    // Un-set rather than zeroed -- this editor's own rule (below) is that an
    // untouched slider shows the base cry's value, not a fixed number, so a
    // bend left over from the previous base would otherwise come along
    // uninvited and the "new" cry would be quietly still warped by it.
    delete cry.pitch; delete cry.length;
    // Picking a chip base after an import means the import lost -- clear it
    // so the record can't carry both a {base} and a {file} at once.
    delete cry.file; delete cry.name; delete cry.ext; delete cry.b64;
    touch(); renderMonTab();
  }, { blank: "— no cry (silent) —" }));

  if (cry.file) {
    body.append(el("p", { class: "hint good" },
      "Using an imported recording instead of one of the game's own — see below to change or "
      + "remove it."));
  } else if (!cry.base) {
    body.append(el("p", { class: "hint" }, "Left empty, it makes no sound at all."));
  }

  if (!cry.file && cry.base) {
    const playable = criesPlayable();
    const base = vanillaCry(cry.base);

    /* The sliders sit at the base cry's own values until they are moved, so
       "start from PIDGEY" shows -- and plays -- PIDGEY rather than something at
       an invented midpoint. Nothing is written to the record until the user
       actually moves one, which is what keeps an untouched cry exporting as a
       plain {base} with no modifiers. */
    const slider = (label, key, min, max, hint) => {
      const val = cry[key] ?? base?.[key] ?? 128;
      const out = el("span", { class: "statword" }, String(val));
      body.append(el("label", {}, label));
      body.append(el("div", { class: "row" },
        el("input", {
          type: "range", min: String(min), max: String(max), value: String(val),
          // The number keeps up live; the sound waits to be asked for. Playing
          // on every slider move meant a cry every few pixels of a drag, which
          // is noise rather than feedback -- the button below is the one place
          // sound comes from.
          oninput: (e) => { cry[key] = Number(e.target.value); out.textContent = e.target.value; touch(); },
        }), out));
      body.append(el("div", { class: "hint" }, hint));
    };
    slider("Pitch", "pitch", 0, 255,
      "Not a simple high-to-low: the number is added to the raw pitch and wraps round, so it "
      + "sweeps down, jumps, and climbs again. Worth dragging with the sound on.");
    slider("Length", "length", 1, 255,
      "How drawn-out it is. Under about 128 nothing changes — the noise part of a cry runs at a "
      + "fixed rate and is still the longest thing playing.");

    if (playable) {
      body.append(el("div", { class: "row", style: "margin-top:12px" },
        el("button", { class: "primary fixed", onclick: () => playCry(cryDefFor(cry)) }, "▶ Play it"),
        el("span", { class: "hint" }, "Plays whatever the two sliders currently say.")));
      body.append(el("p", { class: "hint" },
        "Built the same way the game builds it — the sound chip running this cry's own program — so "
        + "what you hear is what the player will hear."));
    } else {
      body.append(el("p", { class: "hint" },
        "There is no way to play it in this copy of Oak's Lab — it was built without game data, "
        + "which is where the sound programs live. Regenerate it locally to hear cries here."));
    }
  }

  renderAudioImport(body,
    () => (cry.file ? { name: cry.name, ext: cry.ext, b64: cry.b64 } : null),
    (v) => {
      if (v) {
        cry.file = `cries/${(m.id || idFromName(m.data.name) || "CRY").toLowerCase()}.${v.ext}`;
        cry.name = v.name; cry.ext = v.ext; cry.b64 = v.b64;
        delete cry.base; delete cry.pitch; delete cry.length;
      } else {
        delete cry.file; delete cry.name; delete cry.ext; delete cry.b64;
      }
    },
    () => { touch(); renderMonTab(); });
}

/* ------------------------------------------------------------- 7. spawns -- */

/**
 * Where it turns up in the wild.
 *
 * A map's wild table is ten slots and the slot decides the odds -- slot 1 is
 * a fifth of every encounter, slot 10 is one in eighty. So this shows the
 * whole table with the rarities spelled out and lets a species be dropped
 * into particular slots, rather than asking for a "rarity" the engine has no
 * field for.
 */
function stepMonSpawn(host, m) {
  const mine = spawnMapsFor(m);
  const fixed = monEncountersFor(m);
  const noteBits = [...mine, ...fixed.map((f) => f.map.id)];
  const body = monStep(host, 7, "Where it lives",
    noteBits.length ? noteBits.join(", ") : "nowhere in the wild");

  body.append(el("div", { class: "who" }, "Wild encounters"));
  body.append(el("p", { class: "hint" },
    "Wild Pokemon come out of a per-map table of ten slots. Which slot decides how often: "
    + "the first is a fifth of everything you meet, the last is barely one in eighty. Put this "
    + "one in a slot and it starts turning up there."));

  const maps = allIds("maps") || [];
  const pick = el("select", {
    onchange: (e) => { if (e.target.value) { openSpawnEditor(m, e.target.value); e.target.value = ""; } },
  });
  pick.append(el("option", { value: "" }, "— add it to a map's wild table —"));
  appendIdOptions(pick, maps, "", (o) => {
    const has = GAME?.encounters?.[o.id]?.grass || entryFor("encounters", o.id)?.data?.grass;
    return idLabel(o) + (has ? "" : "  (no wild Pokemon here)");
  });
  body.append(pick);

  if (!mine.length) {
    body.append(el("p", { class: "hint" },
      "It can still be given out by a person, found in a ball, or evolved into — a Pokemon does "
      + "not have to be catchable to be in the game."));
  } else {
    for (const mapId of mine) {
      body.append(el("button", { style: "margin-top:6px", onclick: () => openSpawnEditor(m, mapId) },
        "Edit " + mapId + "'s wild table"));
    }
  }

  body.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:14px 0" }));
  monFixedEncounterSlot(body, m, fixed);
}

/**
 * A fixed spot in the world, the Mewtwo/legendary-bird way -- one Pokemon,
 * standing in one place, that battles the moment it is approached, instead of
 * a random roll in the grass. Authored as an ordinary NPC (an object on a map
 * with a talk script) so the NPC tab's own placement and movement steps do
 * the rest of the work -- there is no separate "static encounter" concept to
 * build here, only a shortcut to the one that already exists.
 */
function monFixedEncounterSlot(host, m, fixed) {
  host.append(el("div", { class: "who" }, "Fixed Overworld Encounter"));
  host.append(el("p", { class: "hint" },
    "One Pokemon standing in one spot, that battles the moment it is approached — no grass roll "
    + "involved. This is how Mewtwo waits at the back of Cerulean Cave and how the birds are found."));

  if (!m._art?.overworld) {
    host.append(el("p", { class: "hint bad" }, "An overworld sprite must be selected first."));
  }

  monOverworldSlot(host, m);

  host.append(el("hr", { style: "border:0;border-top:1px solid var(--line);margin:12px 0" }));
  monEncounterWhere(host, m, fixed);
}

/* Which map the placement picker is currently showing, and for whom.
   Render-only: keyed by species so switching Pokemon does not leave the last
   one's map on screen, and never saved -- where it actually stands lives on
   the map object itself. */
let monPlaceAt = { uid: null, mapId: "" };

/**
 * Where it stands: pick a map, tap the spot.
 *
 * Deliberately its own copy of the NPC screen's location step rather than a
 * jump into it. The two workspaces share the low-level pieces they both need
 * -- the map picker, the tappable mini map, the map record -- and nothing
 * else: a species is edited on the Pokemon tab from start to finish.
 */
function monEncounterWhere(host, m, fixed) {
  host.append(el("div", { class: "who" }, "Where it stands"));

  if (!m._art?.overworld) {
    host.append(el("p", { class: "hint warn" },
      "Give it something to look like on the map first — there is nothing to stand there yet."));
    return;
  }

  for (const f of fixed) {
    host.append(el("div", { class: "row", style: "margin-top:6px" },
      el("span", { class: "hint", style: "flex:1" },
        `On ${f.map.id} at ${f.npc.x}, ${f.npc.y} — level ${f.node.args.levelOrParty || 50}`),
      el("button", { class: "fixed danger", onclick: () => removeMonEncounter(f) }, "Remove")));
  }

  if (monPlaceAt.uid !== m._uid) monPlaceAt = { uid: m._uid, mapId: fixed[0]?.map.id || "" };
  const mapId = monPlaceAt.mapId;

  host.append(el("label", { style: "margin-top:10px" }, fixed.length ? "Put another one on" : "Which map"));
  host.append(refSelect("maps", () => mapId, (v) => {
    monPlaceAt = { uid: m._uid, mapId: v };
    renderMonTab();
  }, { blank: "— pick a map —" }));

  if (!mapId) {
    host.append(el("p", { class: "hint" },
      fixed.length ? "Pick another map to put a second one somewhere else."
        : "Pick the map it waits on, then tap the spot."));
    return;
  }

  // The one already on this map, if there is one -- tapping moves it rather
  // than dropping a second copy in the same place.
  const here = fixed.find((f) => f.map.id === mapId) || null;
  const marker = { x: here ? here.npc.x : -1, y: here ? here.npc.y : -1 };

  host.append(el("div", { style: "margin:10px 0;overflow:auto" },
    miniMap(mapId, marker, (cx, cy) => {
      placeMonEncounter(m, mapId, cx, cy, here);
      renderMonTab();
    })));

  host.append(el("p", { class: "hint" },
    here ? `Standing at cell ${here.npc.x}, ${here.npc.y}. Tap again to move it.`
      : "Tap the map to place it. Red squares are cells the player cannot walk on."));

  if (here) {
    host.append(el("label", {}, "What level it is"));
    host.append(el("input", {
      type: "number", min: "1", max: "100", value: String(here.node.args.levelOrParty || 50),
      oninput: (e) => {
        here.node.args.levelOrParty = Math.max(1, Math.min(100, Number(e.target.value) || 50));
        touch();
      },
    }));
    host.append(el("label", {}, "Does it move?"));
    host.append(el("select", {
      onchange: (e) => { here.npc.movement = e.target.value; touch(); },
    },
      ...[["STAY", "Stands still"], ["WALK", "Wanders around"]]
        .map(([v, t]) => el("option", { value: v, selected: here.npc.movement === v }, t))));
    const art = monOverworldArt(m);
    if (here.npc.movement === "WALK" && art && art.walker === false) {
      host.append(el("p", { class: "hint warn" },
        "That sprite has no walking frames, so it will slide rather than walk."));
    }
  }
}

/**
 * Every fixed encounter this species has, found by the mark the placement
 * leaves on the map object.
 *
 * Reads P.maps directly rather than going through allNpcs -- these objects are
 * deliberately invisible to the NPC workspace, which is the whole point of the
 * mark.
 */
function monEncountersFor(m) {
  const out = [];
  if (!m.id) return out;
  for (const map of [...P.maps, ...P.mapDrafts]) {
    (map.rec.objects || []).forEach((o, i) => {
      if (o._monEncounter !== m.id) return;
      const script = P.scripts.find((s) => s.textKey === o.text) || null;
      const node = script?.nodes.find((n) => n.verb === "start_battle") || null;
      if (!node) return;
      out.push({ npc: o, map, i, script, node });
    });
  }
  return out;
}

/**
 * Put it on a map, or move the one already there.
 *
 * A fixed encounter IS a map object with a one-block script -- that is the
 * engine's own idiom for Mewtwo and the birds, and there is no separate
 * "static encounter" record to make. What is written here is the same shape
 * the NPC screen writes, minus every part of the NPC workflow.
 */
function placeMonEncounter(m, mapId, x, y, existing) {
  if (!m.id) { toast("Give it a name first.", true); return; }
  const target = mapRecordFor(mapId);
  if (!target) { toast("Load game data before placing it", true); return; }

  if (existing) {
    if (existing.map.id === mapId) { existing.npc.x = x; existing.npc.y = y; touch(); return; }
    existing.map.rec.objects.splice(existing.i, 1);
  }

  const o = {
    _uid: uid(), _monEncounter: m.id, _display: monName(m),
    name: idFromName(monName(m)), sprite: monOverworldSpriteId(m),
    movement: "STAY", range: "NONE", x, y, text: "",
  };
  // Vanilla object indices are single digits; start clear of them so save keys
  // like "<mapId>_obj_<index>" never collide.
  const used = new Set(target.rec.objects.map((r) => r.index));
  let index = 90;
  while (used.has(index)) index++;
  o.index = index;

  o.text = freeTextKey("TEXT_" + o.name, null);
  const s = newScript(monName(m), mapId, "talk");
  s.textKey = o.text;
  // No dialogue before the fight -- a legendary does not introduce itself.
  s.nodes[0].verb = "start_battle";
  s.nodes[0].args = { kind: "wild", who: m.id, levelOrParty: 50 };
  P.scripts.push(s);

  target.rec.objects.push(o);
  touch();
  toast(monName(m) + " placed on " + mapId);
}

function removeMonEncounter(f) {
  if (!confirm(`Take ${f.npc._display || "it"} off ${f.map.id}?`)) return;
  f.map.rec.objects.splice(f.i, 1);
  if (f.script) P.scripts = P.scripts.filter((s) => s !== f.script);
  touch();
  renderMonTab();
}

const entryFor = (registry, id) => P.entries.find((e) => e.registry === registry && e.id === id) || null;

// Which maps this species already appears on, counting the mod's own edits.
function spawnMapsFor(m) {
  const out = [];
  for (const e of P.entries) {
    if (e.registry !== "encounters") continue;
    const hit = ["grass", "water"].some((w) => (e.data?.[w]?.slots || []).some((s) => s.species === m.id));
    if (hit) out.push(e.id);
  }
  return out;
}

/**
 * The ten slots of one map's table, with the odds on every row.
 *
 * Starts from whatever that map already has -- the vanilla table if the mod
 * has not touched it -- so dropping a new species in is an edit to a real
 * place rather than a table invented from nothing.
 */
function openSpawnEditor(m, mapId) {
  let entry = entryFor("encounters", mapId);
  if (!entry) {
    const vanilla = GAME?.encounters?.[mapId] || {};
    entry = {
      _uid: uid(), registry: "encounters", verb: "patch", id: mapId,
      data: JSON.parse(JSON.stringify({
        grass: vanilla.grass || { rate: 25, slots: [] },
      })),
    };
    P.entries.push(entry);
  }
  const grass = entry.data.grass || (entry.data.grass = { rate: 25, slots: [] });
  while (grass.slots.length < 10) grass.slots.push({ species: "", level: 5 });
  grass.slots.length = 10;

  const body = el("div", {});
  body.append(el("p", { class: "hint" },
    "Ten slots, rarest at the bottom. Set a slot to " + (m.id || "this Pokemon")
    + " to make it turn up here."));

  body.append(el("label", {}, "How often the grass has anything in it at all"));
  const rateOut = el("span", { class: "statword" }, String(grass.rate ?? 25));
  body.append(el("div", { class: "row" },
    el("input", {
      type: "range", min: "0", max: "255", value: String(grass.rate ?? 25),
      oninput: (e) => {
        grass.rate = Number(e.target.value);
        rateOut.textContent = `${grass.rate}  (${Math.round(grass.rate / 256 * 100)}% a step)`;
        touch();
      },
    }), rateOut));
  rateOut.textContent = `${grass.rate ?? 25}  (${Math.round((grass.rate ?? 25) / 256 * 100)}% a step)`;

  const table = el("div", { style: "margin-top:10px" });
  for (let i = 0; i < 10; i++) {
    const slot = grass.slots[i];
    const row = el("div", { class: "slotrow" });
    row.append(el("span", { class: "slotpct" }, SLOT_PCT[i].toFixed(1) + "%"));
    row.append(refSelect("pokemon", () => slot.species || "", (v) => { slot.species = v; touch(); }, { noFilter: true, blank: "— empty —" }));
    row.append(el("input", {
      type: "number", min: "1", max: "100", value: String(slot.level || 5), class: "slotlvl",
      oninput: (e) => { slot.level = Math.max(1, Math.min(100, Number(e.target.value) || 5)); touch(); },
    }));
    row.append(el("button", { class: "fixed", onclick: () => { slot.species = m.id; touch(); closeDialog(); openSpawnEditor(m, mapId); } }, "use this"));
    table.append(row);
  }
  body.append(table);
  body.append(el("p", { class: "hint" },
    "A slot left empty is a slot the roll can land on and find nothing, which just means no "
    + "encounter that step."));
  body.append(el("div", { class: "row", style: "margin-top:10px" },
    el("button", { class: "primary", onclick: () => { closeDialog(); renderMonTab(); } }, "Done"),
    el("button", {
      class: "fixed danger",
      onclick: () => {
        P.entries = P.entries.filter((e) => e !== entry);
        touch(); closeDialog(); renderAll();
      },
    }, "Stop editing this map")));

  dialog(mapId + " — wild Pokemon", body);
}

/* ------------------------------------------------------------- 8. footer -- */

function stepMonFooter(host, m) {
  // A draft's "add it" story is told entirely by the bar at the top of the
  // tab now (the button, greyed out with why); repeating it down here was
  // the only reason this step existed for a draft at all.
  if (isMonDraft(m)) return;

  const body = monStep(host, null, "This one is in your mod");
  body.append(el("p", { class: "hint" },
    "It exports as a pokemon:register in main.lua, with any picture you imported beside it in "
    + "the zip. Everything above edits it in place."));
}

/* --------------------------------------------------------------- copying -- */

/**
 * Start from one of the game's own.
 *
 * Copying BULBASAUR and changing four things is how most people should make
 * their first one, and it is far more likely to produce something that plays
 * well than filling twenty fields from nothing.
 */
function copyMonDialog() {
  const rows = Object.values(GAME?.pokemon || {});
  if (!rows.length) { toast("Load game data to copy one of the game's Pokemon", true); return; }

  const body = el("div", {});
  body.append(el("p", { class: "hint" },
    "Takes its stats, types, moves and pictures as a starting point. The copy gets its own name, "
    + "id and Pokedex number — nothing about the original changes."));
  const grid = el("div", { class: "spritegrid" });
  const fill = (needle) => {
    grid.textContent = "";
    for (const r of rows) {
      if (needle && !r.id.toLowerCase().includes(needle)) continue;
      const p = GAME?.monFront?.[r.id];
      grid.append(el("div", { class: "spritepick", onclick: () => startMonCopy(r) },
        p ? artCanvas("front:" + r.id, p.png, 0, 0, p.w, p.h, 1) : null,
        el("span", {}, `${r.name || r.id}  ${monBst(r.baseStats)}`)));
    }
    if (!grid.children.length) grid.append(el("div", { class: "empty" }, "nothing matches"));
  };
  body.append(el("input", {
    type: "search", placeholder: `search ${rows.length}…`,
    oninput: (e) => fill(e.target.value.trim().toLowerCase()),
  }));
  fill("");
  body.append(grid);
  dialog("Copy one of the game's Pokemon", body);
}

function startMonCopy(rec) {
  const m = blankMon();
  m.data = {
    ...JSON.parse(JSON.stringify(rec)),
    name: "", dex: freeDexNumber(),
  };
  delete m.data.id;
  delete m.data.index;          // the ROM's internal slot; a new one has none
  delete m.data.dexEntry;       // points at a ROM text label, not real words
  m.data.name = "";
  m._art = { front: { source: "game", id: rec.id }, back: { source: "game", id: rec.id } };
  if (rec.cry) m._cry = { base: rec.cry };
  else if (GAME?.ids?.cries?.some((c) => c.id === rec.id)) m._cry = { base: rec.id };
  m.id = "";
  P.monDraft = m;
  P.sel.mon = "draft";
  touch(); closeDialog(); renderMonTab();
  toast("Copied " + (rec.name || rec.id) + " — give it a name");
}

/* ---------------------------------------------------------------- export -- */

/**
 * The cry records this mod adds, collected at emit time.
 *
 * A cry is authored on the species screen but is its own registry, so it is
 * gathered here the same way imported art is -- nothing in P.entries has to
 * hold it.
 */
function monCryRecords() {
  const out = [];
  for (const m of allMons()) {
    const c = m._cry;
    if (!m.id || !c) continue;
    if (c.file) { out.push({ id: m.id, data: { file: c.file } }); continue; }
    if (!c.base) continue;
    const data = { base: c.base };
    if (c.pitch != null) data.pitch = c.pitch;
    if (c.length != null) data.length = c.length;
    out.push({ id: m.id, data });
  }
  return out;
}

// The raw bytes an imported cry needs alongside its {file} record -- same
// idea as customArtFiles/monArtFiles, gathered at emit time rather than
// living in P.entries.
function monCryAudioFiles() {
  const out = [];
  for (const m of allMons()) {
    const c = m._cry;
    if (!c?.file || !c.b64) continue;
    out.push({ name: c.file, bytes: base64Bytes(c.b64) });
  }
  return out;
}

// Point each species at its own cry, if it has one.
function syncMonCry() {
  for (const m of allMons().concat(P.monDraft ? [P.monDraft] : [])) {
    if ((m._cry?.base || m._cry?.file) && m.id) m.data.cry = m.id;
    else delete m.data.cry;
  }
}
