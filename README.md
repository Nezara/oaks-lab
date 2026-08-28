# Oak's Lab — a novice modding tool for gen1recomp

**Status: alpha.** It works, it is being actively rewritten, and its save
format and file layout can still change between versions.

A prototype. One HTML file, no install, works on a phone. It covers content
records (NPCs, Pokemon, Moves, Items), a node-based script editor, and a map
editor, folded into one project.

It is deliberately **not** as powerful as the
[Content Editor](https://github.com/zeak6464/Gen1Recomp-Content-Editor). The
goal is to get someone from "I have an idea" to "I have a working mod" without
them writing Lua, and to leave them holding readable Lua at the end so the
next tool is a step up rather than a fresh start.

## Run it

**Open `oaks-lab.html`** (project root, from a
[Release](../../releases) — it's gitignored in the source tree, see
[Building](#building) below). Double-click it, or copy that one file to a
phone and open it from the file manager. No server, no internet, no
install — it is a single self-contained page and it makes zero network
requests.

## Building

```bash
node build.mjs               # local build, game data embedded
node build.mjs --no-gamedata # shareable build, no ROM-derived bytes
```

Do not open `src/app.html` directly. It is the template, not the app: its
content is substituted in at build time, so opening it gives you a page that
looks right and does nothing. It now says so rather than failing silently.

`tools/serve.mjs` exists only for previewing in a desktop browser that blocks
`file://`. The app itself never needs it.

## How it is put together

```
tools/fetch-wiki.mjs          refresh data/wiki/*.md from the engine wiki
tools/build-schema-pack.mjs   data/wiki/*.md      -> data/schema-pack.json
tools/lua-data.mjs            parser for the engine's generated .lua tables
tools/extract-gamedata.mjs    ROM cache + zone_editor -> data/gamedata.json
tools/extract-copy.mjs        src/*.js UI text        -> copy.md, for hand-editing
tools/apply-copy.mjs          copy.md (edited)         -> back into src/*.js -- see tools/README.md
src/app.html                  markup, styles, placeholders
src/core.js                   project state, Lua emitter, form generator, zip
src/script.js                 node editor, graph -> rows compiler, dry run
src/map.js                    block painting, warps, signs, NPCs, mini-maps
src/zone.js                   compound tilesets, sub-tiles, painted collision
src/wizard.js                 the guided flows and the deletion cascades
src/npc.js                    the NPC workspace and its docked node editor
src/mon.js                    the Pokemon workspace
src/move.js                   the Moves workspace
src/item.js                   the Items workspace
src/sprite.js                 sprite pickers and importers
src/cry.js                    cry/SFX synth, shared by cries and move sound
src/ui.js                     tabs, Start guide, Content tab, Export tab
build.mjs                     concatenates the above into oaks-lab.html (project root)
```

### The schema pack is the spine

Nothing about pokemon, moves, items or trainers is hardcoded. The engine's
[registry reference](https://github.com/bryanthaboi/gen1recomp/wiki/Reference-Registries)
is itself generated from `src/mods/Schemas.lua`, so parsing it gives a schema
that cannot drift from the engine:

```
registries : 46 (191 fields)
commands   : 65 (30 curated, 8 branching)
manifest   : 25 fields
```

Every content form is generated from that. Adding coverage is
`node tools/build-schema-pack.mjs`, not a code change. When the engine ships a
new registry, re-run `fetch-wiki` then `build-schema-pack` and the tool knows
about it.

Twelve type patterns cover all 191 fields — `string`, `integer 0..255`,
`list of moves id`, `one of "physical" | "special"`, `{hp, attack, ...}` and so
on. Anything unrecognised degrades to a raw JSON box rather than being dropped,
so a form is never a lie about what it covers.

### Nothing asks you to know an id

Every field that wants an engine id is a dropdown, never a box you have to
type `OPP_BUG_CATCHER` into from memory. `tools/extract-gamedata.mjs` parses
the engine's own decoded data cache
(`%APPDATA%/pokemon-love2d/red/data/generated/*.lua`) with a small exact parser
for the pretty-printer's Lua subset, and produces id lists for 17 registries:

```
pokemon 151   items 152   moves 165   trainers 47   maps 222
sprites 73    tilesets 24  cries 154   move_effects 68   music 24
type_chart 15 growth_rates 4  evolution_methods 3  palettes 37  encounters 59
sfx 104       battle_anims 202
```

Lists show the friendly name beside the id (`BUG CATCHER — OPP_BUG_CATCHER`),
sort by the game's own index so Bulbasaur is first, include ids this mod is
adding marked `(yours)`, keep an unknown value from another mod rather than
dropping it, and grow a search box past 40 entries.

New ids are the one exception — they cannot be in a list — so they get derived
from the name instead: type "Hidden Cave", get `HIDDEN_CAVE`.

## The workspaces

The Content tab is a strip of workspaces — **NPC**, **Pokemon**, **Moves**,
**Items**, **Maps** — one per kind of thing, plus **All records** for the
generic registry editor.

<details>
<summary><strong>NPC workspace</strong> — people, dialogue, trainers, sprites, import</summary>

### People are a workspace, not a wizard

The NPC workspace is one scrolling column of numbered steps — name, sprite,
location, movement — with the node editor **docked underneath it**, resized by
dragging its orange bar and collapsed by the chevron on the right. The point is
that nothing is a one-shot: a wizard asks its questions once and then scatters
the answers across three tabs, where this keeps all of them on screen and lets
you change any of them in any order, watching the graph the whole time.

Steps 1–4 write to the same map object the Maps tab has always edited, so
nothing about the export changed. Renaming works from either screen and moves
the display name, the `SHOUTY_ID`, the `TEXT_` constant and the script behind
it together.

Step 5 edits nothing. Everything about what a person *is* and *does* lives in
the graph, and that step only says what the graph currently adds up to and
scrolls you down to it.

An NPC being invented is held aside until step 3 says where they stand — a
person at cell `-1,-1` is not a person — and only lands in a map record when
you press **Add them to the mod**. Until then **Discard** is a real way out.

#### A trainer is just an ordinary block

There is no special "this person is a trainer" block. A trainer is a **Start
a battle** block, wired up like anything else — because a mod NPC does not
need to be built the way a vanilla one is stored internally to behave the
same way at the table. Vanilla gets its challenge/rematch switch for free from
a trainer header the mod API cannot write to (checked: no `trainer_headers`
registry, and `field` does not carry it either), so a mod trainer earns the
same switch honestly, with the blocks already on the canvas:

```
[Is flag set? BEAT_ROUTE_KID]
  YES ─► [Say "You're strong!"]
  NO  ─► [Say "Let's battle!"] ─► [save end battle text: "I lost!"] ─► [Start a battle]
                                                                              │ then
                                                                    [Did player win?]
                                                                              │ YES
                                                                       [Set flag BEAT_ROUTE_KID]
```

Nothing forces this shape. Drop a bare **Start a battle** block with nothing
in front of it and it fights every single time — that is a legitimate choice
too, not a mistake the tool corrects.

#### The Pokemon team block

**Start a battle** grows an extra **team** arrow when its kind is set to
`trainer`. Point it at a **Pokemon team** block — a table, six rows, species
and level each, right there in the block's own inspector. No sub-blocks to
place or wire: pick a species from the dropdown, type a level, done. A blank
species means the row is unused.

Level is where it stops, and that stop is a real one: neither the `trainers`
registry nor `give_pokemon` has a moves field anywhere. The engine always
derives a Pokemon's battle moves from its species' own learnset at that
level, so there is nothing to author per trainer — only per species, by
editing that species' learnset, which then changes every Pokemon of that
species everywhere.

The team is optional. **Start a battle**'s own `who` field is a plain trainer
picker — point it straight at one of the game's 47 or one of this mod's own,
no team block required. Connecting a team only touches a trainer this mod
made (`isOwnTrainer`); pointing `who` at an existing vanilla trainer with no
team connected leaves that trainer's data alone.

#### Import takes one of the game's own people apart

Pick a map, pick somebody standing on it, and their sprite, position,
movement and **dialogue rebuilt as nodes** land in the workspace as a copy you
can change. The original is untouched. This is the one thing a tutorial cannot
do: "how does the game do it?" and "how do I do it?" end up being the same
picture.

The words come from resolving the chain the ROM actually uses —
map object → `TEXT_*` constant → `text_pointers.lua` → `text.lua` — and the
`\012` control code that starts a fresh text box becomes a new node, which is
exactly where the tool would have put one.

Trainers import as trainers, with all three of their lines. Their words are
**not** in the text table — their `text_pointers` entry is `asm = true` with no
string, which is why they used to import saying "...". The real text is in
`trainer_headers.lua`, already split before / on-defeat / after, landing on
the three blocks one-for-one. Import Mt Moon's hiker and you get his actual
"WHOA! You shocked me!", "Wow! Shocked again!" and "Kids like you shouldn't be
here!" Vanilla people who battle are tagged **battles** in the import list,
with their sight range shown, before you pick.

A copy never inherits the original's `TEXT_` constant. Registering
`talk.TEXT_PALLETTOWN_FISHER` on Pallet Town would rewrite what the *real*
fisher says instead of giving your person words, and the obvious name for a
copy walks straight into it, so the constant is de-duplicated against every
vanilla one.

One thing the tool cannot give a mod trainer: **sight range**. Vanilla stores
it per trainer in the header (`0` = must be talked to, `2`–`4` = spots you
that far), and with headers closed to mods there is nowhere to write it.

#### Three sprite slots, from the game or from a file

Overworld, facing and back, each with **Select sprite** (a picker showing the
game's own decoded art, not a list of ids) and **Import custom sprite sheet**.
The overworld strip is shown cut into its frames beside the picker, because a
sheet cut at the wrong height reads as nonsense there long before it does in
the game.

Only the overworld slot exports so far: an imported sheet ships as a PNG in
the zip with a `sprites:register` beside it, sized from the image. Facing and
back are kept and previewed, but they belong to the trainer record and start
exporting when a person can be battled.

</details>

<details>
<summary><strong>Scripts</strong> — the node editor, its compiler, and its test runner</summary>

### The flows ask questions in the order you think them

The engine's record order is not the order a person reasons in. Nobody picks a
catch rate before naming the thing. So adding a species or a place goes
through a stepped flow — the same ordering the NPC workspace above uses, still
as a wizard until those two get workspaces of their own:

- **A species** — what is it called → what type is it → where does it live in
  the wild (optional; rewrites only the slots you ask for and leaves the rest
  of the area's wildlife alone) → *then* the stats form.
- **A place** — what is it called → what does it look like → how do you get in
  (pick a map, tap the spot; the return warp is made for you) → *then* the
  painting.

Editing a vanilla map says so, plainly, at the point you do it: your additions
are appended, nothing vanilla is removed, disabling the mod puts it back — but
another mod rewriting the same map could clash.

### Everything can be deleted

Content records, scripts and maps each have a delete on their list row.
Deleting is not just a splice:

- Deleting a **place** offers to take back the door it punched into the vanilla
  map, and drops the patch record entirely if that door was the only thing in
  it. Otherwise the mod ships a door to nowhere.
- Deleting a **script** offers to unlink whoever was pointing at it, rather
  than leaving characters talking to a TEXT constant that no longer exists.

### Scripts are a graph already

A gen1recomp script is an array of rows, `{ "verb", arg1, ... }`, with `label`
rows as jump targets. That is a graph written down, so the node editor is a
serialiser, not a code generator. Each node is one row; each edge is
fall-through or a jump.

The exception is **Pokemon team**, which describes a party rather than a
step — it emits no row. `rowFor` skips it via `mf: true` in `MF_VERBS`;
`syncBattleTeams` folds its six-row table into the trainers registry, and
into the `who`/`levelOrParty` args of whichever **Start a battle** block
points at it, right before the compiler reads either.

Edges are named ports rather than a fixed `next`/`no` pair: `portsOf(node)`
returns `{key, label, cls}` for each exit, and rendering, wiring, arranging,
deletion and reachability all read from it. `next` and `no` are just two of
the names — `start_battle` gains a `team` port when its kind is `trainer`,
patched onto the real engine verb rather than invented as a new kind of block.

The compiler mints labels only where they are needed — a node with more than
one way in, or the false side of a branch — so a straight conversation
compiles to straight rows. The talking-NPC recipe produces:

```lua
mod.content.map_scripts:register("PALLET_TOWN", {
  talk = {
    TEXT_SECRET_KEEPER = {
      { "ask", "Want to hear a\nsecret?" },
      { "jump_if_false", "otherwise" },
      { "show_text", "The sign in this\ntown is MODDED." },
      { "jump", "end" },
      { "label", "otherwise" },
      { "show_text", "Suit yourself." },
    },
  },
})
```

which is the shape
[Tutorial 06](https://github.com/bryanthaboi/gen1recomp/wiki/Tutorial-06-NPC-And-Dialogue)
teaches by hand.

The canvas is the palette: the left strip keeps the handful of common blocks,
and **right-click anywhere on the canvas** searches all 61 by name or category
and drops one exactly where you pointed; **Delete** removes the selected
block. The canvas fills its whole pane, so the right-click works in empty
space and not only near existing nodes.

### Test it without the game

**Test it** interprets the compiled rows against fake save state — flags, bag,
money, branches — and shows the text in a mock text box. You can walk both
sides of a conversation on a phone with the game nowhere in sight. It is also
a second opinion on the compiler: a branch the interpreter cannot reach is one
the engine cannot reach either.

</details>

<details>
<summary><strong>Moves workspace</strong> — status chance, animation playback, sound</summary>

Eight steps, same shape as the other workspaces. Three of them are more than a
form, and each because the engine's own data made the honest answer awkward.

**The status chance (step 4).** Gen 1 has no "30% chance to burn" field. It
has sixty-eight named effects, four of which happen to burn things, and the
odds are baked into each one — `BURN_SIDE_EFFECT1` rolls 26 out of 256,
`BURN_SIDE_EFFECT2` rolls 77. So the step asks the question a person actually
has (which condition, how often) and resolves it: if the game already means
that, it names the vanilla effect and the mod ships no code at all; if it does
not, Oak's Lab writes the effect, longhand, as the engine's own `statusSide`
written out. Which of the two it did is shown, not hidden. The type rule that
catches everybody out — a secondary status never lands when the move's type
matches one of the target's, so a Fire move cannot burn a Fire-type at any
chance — is stated where it applies.

**The animation (step 5) plays, two ways.** Borrowing one of the game's 202
plays through `compileAnim`, a port of the engine's own `AnimPlayer:start` —
same OAM buffer simulation, same four frame-block modes — so what plays in
the browser is what plays in the game, drawn on the real battle screen
because these tiles are transparent-on-white and invisible on anything else.

Painting your own is a second, deliberately simpler path: a strip of frames
(reusing the NPC sprite-strip importer's own "filmstrip" mode) that plays 1
through N in order, at a spot chosen by tapping the mock screen or typing
the position number directly. Borrowing one of the game's animations (or
exporting its art) states which of the 177 it draws at, so a painted
replacement can be told the same number rather than eyeballing a click
against a picture with nothing to compare it to.

"Export the game's art" replays any of the 202 and photographs it frame by
frame, handing back the picture as it appears on screen — not the raw tile
sheet, which is unordered 8x8 cells shared by every animation. The strip
comes out as a boxed grid: a 1px magenta guide line around and between every
cell, so the edges of each frame are visible while painting. Those guides
are also how the import reads the cells back — `guideGridBoxes` takes the
spans between fully-guide-coloured rows and columns, then strips the
magenta — so the sheet describes its own grid and survives a round trip
through a paint program that knows nothing about any of this. Sheets without
guides fall back to island detection. Frames the game holds still are
exported once, and how long each was held is reported ("held 4 game-frames
each"), since that is the one thing a strip cannot carry. It does not go
through `battle_anims` at all — there is no registry route for a new tile
*arrangement* (only for borrowing the game's own, or registering a tile
sheet), so a hand-painted strip cannot become a content record no matter how
it is shaped. Instead it exports as a small shared Lua helper:
`mod.events:on("battle.move_used", ...)` starts playback and holds the turn
open with `battle:waitNext` (the same call the engine's own status effects
use); `mod.hooks:wrap("battle.overlay", ...)` draws the current frame once a
frame, after the whole battle screen has finished compositing. One helper is
shared by every move using this — only the per-move table entry grows. The
trade a painted strip makes for that freedom: it plays exactly as painted in
every COLORS display mode, since drawing outside the game's own picture
pipeline means never being recoloured by it.

There is deliberately no step for the overworld (Cut, Surf and friends): Gen 1
checks for them by move id in eight hard-coded places in
`OverworldController`, with no field and no event a mod can answer, so a new
move cannot become a ninth field move — a step whose whole content was "no,
but you can patch an existing one over" was worse than no step. Patching a
vanilla move, for that or anything else, is still possible from the
Content/All records tab.

Sound reuses the cry synth, because a move's `anim = {sound, pitch, tempo}` is
the same arrangement as a cry's `{base, pitch, length}` over the same
three-bytes-per-channel headers. `src/cry.js` gained the seven opcodes battle
sound effects reach for beyond the five a cry uses — a frequency sweep above
all, which is the descending boop behind half the hit sounds. No cry program
touches any of them, so all 154 render byte-identically to before.

</details>

<details>
<summary><strong>Items workspace</strong> — combinable effects, and the one genuine gap</summary>

Seven steps, and the shortest of the three converted workspaces so far — not
because there is less to say, but because almost everything an item "does" in
Gen 1 turns out to be hardcoded to its own id string in a ~600-line waterfall
(`engine/items/item_effects.asm`, ported nearly line for line into
`src/inventory/ItemEffects.lua`), rather than carried in a field. A copy of
POTION under a new id heals nothing at all — there is no `healAmount` field
the engine reads generically, the same trap as a Sonicboom copy dealing no
damage, except moves at least have `fixedDamage` to backfill and items mostly
don't.

**What it does (step 3) is a checklist, not a radio button — items can
combine behaviors.** The obvious question ("can it heal AND be an evolution
stone?") turns out to already have a vanilla precedent: FULL RESTORE isn't
one effect, it's two — try healing to full, and only when the target is
*already* at full HP does it fall through to curing a status instead. So step
3 is an ordered list: tick any of healing/curing/reviving, PP restoring,
evolution-stone matching, or TM/HM-style move teaching, and Oak's Lab writes
one `item_effects.use()` that tries each ticked behavior top to bottom,
falling through until one applies. Order is a real, user-set decision here
(reordered with the ▲/▼ buttons next to each), not cosmetic — copying FULL
RESTORE lands healing above curing for exactly the reason above, and a
"heals or evolves" item genuinely needs the modder to say which one wins
when both could apply. Ticking nothing at all is a valid, common answer too —
that's a plain key item, still the safest starting point since nothing in
the engine is hardcoded against a new id. `machine` (TM/HM) is the one
behavior that is ALSO a native field in its own right, kept alongside the
generated Lua for metadata even when combined with something else, since the
native dispatch path is bypassed the moment an item carries its own `effect`.

**A new catchable Poke Ball turns out to be possible**, which looked like a
dead end on first reading. `ItemEffects.use` only returns the "ball" signal
`BagMenu` needs to throw one for a hardcoded five-id list — but that check
sits inside the *hardcoded* half of `ItemEffects.use`, which an item carrying
its own `effect` never reaches at all. A one-line effect
(`use = function(ctx) return "ball" end`) is the whole trick: BagMenu reads
back the string "ball" and throws using the item's own id, and `balls` (catch
math: `randMax`, `hpFactor`, `wobbleFactor`, `tossAnim`) is a real registry
keyed per-id with no such hardcoded gate. Picking "A Poke Ball variant"
exports both records; `needsTarget` is set to `false` alongside them so the
bag doesn't ask "use on which Pokemon?" before throwing it.

**A vitamin (a permanent stat-exp booster, like CALCIUM) is a genuine gap, on
purpose.** The vanilla item recalculates the Pokemon's stats afterward through
`src/pokemon/Stats.lua`, an engine module outside the documented `ctx` a
mod's own Lua can reach — the same discipline `move_effects` generation
already keeps to (`ctx.inflict`/`ctx.rng`, nothing reached by `require`).
Rather than guess at reproducing the formula by hand and risk it drifting
from the real one, this category isn't offered; PP restoratives and PP UP are
(neither touches stats), and the gap is stated on the step rather than
papered over.

**Items carry no flag of their own** — there is no such field anywhere in the
registry. Step 6 answers the two things people usually mean by that as
working scripts instead of a fake field: `check_item` gates a door or path
with no flag at all (the vanilla Card Key / S.S. Anne ticket pattern — a sign
or person stands at the doorway, since the warp tile itself has no condition
of its own), and `check_flag` → `give_item` → `set_flag` handles a one-time
pickup or quest reward, the same three blocks the Start tab's fetch-quest
recipe already uses. Either recipe drops a ready-made script onto the Scripts
tab from a button on the step.

Marts are the one honest "not yet": a shop is a map's `text_pointers` entry
carrying a `mart` list, opened by an `open_mart` script block, and there is no
Maps/shopkeeper workspace yet to wrap that in a form. The step shows the two
raw edits it takes today rather than pretending a form exists.

</details>

<details>
<summary><strong>Maps</strong> — block painting, warps, signs, NPCs, and the zone engine</summary>

Block painting, warps, signs and NPCs, on the engine's real coordinate model:
a block is 32x32 px = 4x4 tiles, `blocks` is row-major `width*height`, and
entities sit on the 16px cell grid.

Passability follows `src/world/Map.lua`: a cell is walkable when its
**bottom-left** 8x8 tile is in the tileset's `walkable` list. Checked against
all 222 vanilla maps — 94% of the 916 vanilla NPCs stand on cells this
implementation calls walkable, which matches the engine's own figure.

Patching a vanilla map only writes what you added, via the `__append` wrapper,
so vanilla entries survive. Editing terrain ships the whole `blocks` array,
because that is the only shape the registry takes; the inspector says so.

#### The zone engine

`src/zone.js` brings the standalone
[Gen1 Zone Editor](https://github.com/bryanthaboi/gen1recomp)'s authoring
power into this tab, adapted to Oak's Lab's own map model rather than
replacing it — a map is still the same `{verb, id, rec}` the NPC workspace,
the item balls, the wizard and the linter all already read, so nothing else
had to change. It adds three things, and one line of engine source decides
the shape of all of them (`src/world/Map.lua:221`):

```lua
return self.walkable[self:cellTile(cx, cy)] or false
```

Walkability is a property of the **tile index**, looked up in the tileset's
`walkable` list. It is not per-cell, and there is no per-map collision layer
anywhere in the registry.

**Mixing tilesets is on by default.** Each block cell remembers which tileset
it came from, and on export every distinct tile the map actually used is
composited into one new atlas PNG with the blocks re-indexed against it. It is
the default because it costs nothing when unused: a map that never leaves one
tileset merges back to exactly that tileset and ships no PNG at all. What it
removes is the dead end where a first map wants one tree from FOREST and the
whole thing is already committed to CAVERN.

**Sub-tiles are opt-in.** Splitting each 32x32 block into four 16x16 quadrants
that can be painted independently is a sharper tool than most maps need, and
it multiplies the block count in the compounded atlas, so it stays a toggle.
Click a *quarter* of a block in the palette to load the brush.

**Collision is painted, not just shaded.** Because of the line above, "make
this one cell solid" cannot be stored on the cell — so it isn't. The exporter
mints a **second copy of that tile** in the compounded atlas: identical
pixels, a different index, and only one of the two listed in `walkable`. The
cell points at whichever copy it needs. That is why the two collision tools
quietly turn tileset-mixing on (they need the map to own its tileset), and
why the overlay draws a painted-solid cell darker than one the tileset was
already blocking — the second is a decision that costs a duplicated tile, and
worth being able to see. Asking a cell for what its tile already does clears
the override rather than recording a redundant one, so the atlas only grows
for cells that genuinely needed it.

**The art round-trips.** Export gives you the exact sheet the map ships;
paint over it, keep every tile in its own 8x8 square, and import it back. The
import replaces the **pixels only** and deliberately never re-reads the grid:
re-deriving blocks from an edited image would throw the collision work away,
since two tiles that now look different might still be the walkable/solid
pair the painter minted.

</details>

<details>
<summary><strong>Packaging it for Android</strong> — deferred, but the shape is settled</summary>

Deferred on purpose, but the shape is already settled, so this is a note
rather than an open question.

**The answer is a WebView wrapper, not a rewrite.** One self-contained HTML
file is the best possible input to one — a bare `WebView` Activity pointed at
an asset is a hundred lines of Kotlin with no JS toolchain anywhere in it. It
is also the only option that keeps the CSS open, which is the point: someone
who designs better than we do should be able to come in and improve this
without touching a line of the tool's logic. A native rewrite forfeits that
permanently.

Most of the groundwork is already laid, largely as a side effect of decisions
made for other reasons:

- **Node is build-time only.** `build.mjs` reads `src/` and writes one file.
  Nothing shipped imports, requires or calls it — even the zip writer is
  hand-rolled in `core.js` rather than pulled from JSZip. The app already has
  zero runtime dependencies and makes zero network requests.
- **Game data is already the right shape.** `--no-gamedata` plus **Load game
  data…** is exactly what a phone build wants: ship empty, sideload a pack
  generated on a desktop that has the game. That exists for the reasons in
  [Game data is not ours to ship](#game-data-is-not-ours-to-ship) below;
  mobile gets it for free.
- **Touch already works.** Every canvas and drag handler is `pointerdown` /
  `pointermove`. There is not one `mousedown` in `src/`.
- **`file://` is already survived.** `Store` in `core.js` probes
  `localStorage` and falls back to memory when the property access itself
  throws — the exact failure mode of a page opened from a file with site data
  blocked.

**What needs a bridge is three seams, and no more:**

```
core.js  download()           blob URL + <a download>  -- the one that breaks
core.js  Store                localStorage, already fallback-guarded
ui.js    <input type="file">  needs onShowFileChooser wired
```

`<a download>` on a blob URL is the reliable Android WebView failure; it wants
a `DownloadListener` or a small JS bridge. Keeping every save routed through
that one function is what makes the port a one-file change — a stray
`<a download>` elsewhere is what would turn it into a hunt.

**The one thing that would force a real rewrite** is a phone build having to
derive `gamedata.json` from a raw ROM itself. `tools/extract-gamedata.mjs`
parses the engine's *already-decoded* cache, not the ROM, so that is not a
small port — it is the engine's whole extraction pipeline in JS. The
sideloaded data pack is what avoids ever needing it, which is a second reason
to keep that path first-class rather than letting the embedded build quietly
become the only one that gets tested.

What is genuinely left is layout: this is a multi-pane desktop screen and a
phone is not. That is CSS — the layer deliberately kept open — and it is the
right kind of work to defer, because it wants a real device in hand rather
than a guess.

</details>

## Game data is not ours to ship

`data/gamedata.json` (maps, tilesets, tile sheets, sprite art and vanilla
dialogue) is decoded from the player's own ROM, and is **not committed to
this repo** (see `.gitignore`). `node build.mjs` embeds it for local
convenience if you have generated it yourself; `node build.mjs --no-gamedata`
builds the shareable version — the one this repo's Releases publish — which
loads the same file through **Load game data…** at runtime instead.

Regenerate it locally with:

```bash
node tools/extract-gamedata.mjs
```

It reads your own decoded cache at
`%APPDATA%/pokemon-love2d/red/data/generated`, so it only runs on a machine
with the game installed. Beyond the id lists it also carries what the NPC
workspace draws and reads:

```
overworld sheets 73 (25 KB)   facing pics 45 (32 KB)   back pics 2
dialogue         1162 lines across 216 maps
trainer dialogue 323 before/on-defeat/after sets across 69 maps
trainers         47 full records, parties included
```

Everything except the Maps tab, the sprite pickers, Import and id autocomplete
works with no game data at all.

## What it does not do

- **Hooks and events.** Those are real Lua closures and stay that way. Fields
  the engine types as `function` are shown in forms but not editable; the
  exported `main.lua` is where you add them.
- **Validate like the engine does.** The Export tab's lint is the fast local
  half. `modkit.py` is the real gate and is meant to run in CI — the publish
  helper shows the workflow that does it.
- **Publish.** The publish helper prints the steps and the release workflow;
  it does not touch your GitHub account. The zip it produces is already the
  right shape: `<id>-<version>.zip`, files at the archive root, which is what
  the launcher's Import, Update and Versions features read.
- **Playtest.** The engine is LÖVE and desktop-only. Author on a phone, play
  on a PC.

## Next

- The last workspace: Maps, the way the other four were done — likely
  including a shopkeeper/mart step once it exists, closing the "not a form
  yet" gap the Items workspace's own step 5 currently points at.
- A ninth field move, which needs Lua the overworld can call rather than a
  content record — the obvious next thing to learn after the Moves screen.
- GitHub write path — commit, workflow, tag, release, index PR.
- Round-trip import: read an existing mod's script rows back into the graph.
  The compiler is already a bijection, so this is a parser, not a rewrite. NPC
  import already does the vanilla half of this from the ROM's text tables.
- Art: facing and back sprites through the trainer record, and the
  asset-transform declarations that go with imported sheets. Overworld sprite
  import already ships its PNG and registers the sprite.

## Editing the UI's own text

Every heading, hint, label and warning in Oak's Lab lives as a string inside
`src/*.js`. `tools/extract-copy.mjs` / `tools/apply-copy.mjs` pull it all into
one `copy.md` to edit in a normal text editor and put it back — see
[tools/README.md](tools/README.md) for the full process.

## License

[Oak's Lab License](LICENSE) — free to use, copy, modify and distribute.
The one condition: a mod made with Oak's Lab should credit Oak's Lab and its
creator, Nezara, somewhere in its own credits — e.g. "Made with Oak's Lab by
Nezara".
