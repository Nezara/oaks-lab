# Oak's Lab — a novice modding tool for gen1recomp

**Status: alpha.** It works, it is being actively rewritten, and its save
format and file layout can still change between versions.

One HTML file, no install, works on a phone. It covers content records
(NPCs, Pokemon, Moves, Items), a node-based script editor, and a map editor,
folded into one project.

It is deliberately **not** as powerful as the
[Content Editor](https://github.com/zeak6464/Gen1Recomp-Content-Editor). The goal is to
get someone from "I have an idea" to "I have a working mod" without them
writing Lua, and to leave them holding readable Lua at the end so the next
tool is a step up rather than a fresh start.

This README is in two halves. The **User Guide** below walks through the tool
screen by screen, in the order you actually meet them. **How this works
internally** near the bottom is the design rationale — why things are shaped
the way they are, and what in the engine forced each decision. You do not
need the second half to use the tool.

---

# Quick start

1. **Get the file.** Download `oaks-lab.html` from a
   [Release](https://github.com/Nezara/oaks-lab/releases), or build it yourself
   (see [Building](#building)). It is one self-contained page — no server, no
   internet, no install. Double-click it, or copy it to a phone and open it
   from the file manager.

   Read [Game data](#game-data) first. Whether the build you have carries the
   game's own maps, sprites and dialogue changes what you can do with it, and
   the difference is decided when the file is built, not at runtime.

2. **You land on the Start tab.** Five cards under *What do you want to make?*
   — NPC Editor, Pokemon Editor, Move Editor, Item Editor, Map Editor. Each
   one jumps straight into that workspace. (The two cards under *Tutorial* are
   marked **Coming soon** and are not clickable yet.)

3. **Pick a workspace and build something.** Every workspace is one scrolling
   column of numbered steps, with a toolbar pinned at the top holding **New**,
   a picker for everything of that kind already in your mod, and — while
   you are working on something new — **Add to the mod** and **Discard**.

4. **Press "Add to the mod" when the thing is real.** Until you do, what you
   are editing is a *draft*: it lives in the project, it survives a page
   reload, but it is not part of the exported mod and **Discard** throws it
   away cleanly. The button stays greyed out until the draft has the minimum
   it needs, and hovering it says what is missing.

5. **Check your work on the Scripts tab.** It is a read-only preview of the
   files your mod will ship — `main.lua`, `manifest.json` and the rest —
   with the Lua syntax-highlighted. Nothing here feeds back into the project;
   it is there so you can see what the blocks compiled to.

6. **Finish on the Export tab.** Seven steps: mod name, author, version,
   description, a **Problems** list, then **Download mod .zip**. The zip comes
   out as `<id>-<version>.zip` with the files at the archive root, which is
   the shape the launcher's Import, Update and Versions features read.

7. **Play it on a PC.** The engine is LÖVE and desktop-only. You can author on
   a phone, but you cannot playtest there.

**Save your project as you go.** **Save** in the header downloads
`<id>.modforge.json` — your whole project as one file. **Open** loads one back.
The tool also autosaves to browser storage, but a downloaded `.modforge.json`
is the copy that survives clearing site data, and it is the only way back from
**Clear Project** on the Start tab.

---

# The screen

Four tabs across the top, and two buttons pinned right:

| Tab | What it is |
| --- | --- |
| **Start** | The jumping-off point. Workspace cards, and **Clear Project**. |
| **Content** | Where everything gets made. Six sub-tabs (below). |
| **Scripts** | Read-only preview of the files your mod will ship. |
| **Export** | Mod metadata, the problem list, and the download button. |

| Header button | What it does |
| --- | --- |
| **Save** | Downloads the whole project as `<id>.modforge.json`. |
| **Open** | Loads a `.modforge.json` back in. |

The **Content** tab's sub-tabs are the workspaces: **NPC**, **Pokemon**,
**Moves**, **Items**, **Maps**, and — set apart on the right — **All records**,
the generic editor for anything the five workspaces do not cover.

## The shape every workspace shares

NPC, Pokemon, Moves and Items are all built the same way, so learning one
teaches you the other three.

- **A toolbar at the top that does not scroll away.** On the left, **New** and
  either **Import** (NPC) or **Copy** (Pokemon, Moves, Items), plus a dropdown
  listing everything of that kind in your mod. On the right, either the
  draft controls or, once a thing has been added, an **Updated** flash that
  pulses when your edits have been saved.
- **A numbered column of steps below it.** Each step has a heading, a number,
  and a short grey summary of its current answer beside the title — so
  scrolling the column tells you the state of the whole thing without opening
  anything.
- **Drafts, not forms.** Something you are inventing is a draft until you
  press **Add to the mod**. Drafts show as *— not added yet* in the title bar
  and *(not added yet)* in the picker.
- **Edits to things already added apply immediately.** There is no second
  save. That is what the **Updated** flash is telling you: the button that
  used to sit there is gone because there is nothing left to commit.

---

# User Guide

---

## NPC Editor

**Getting there:** Start tab → *NPC Editor* card, or Content → **NPC**.

This is the only workspace with the node editor docked underneath it, because
what a person *does* is a script, and splitting the two across tabs was the
thing that made people put the tool down.

**The toolbar:** **Import**, **New**, the picker, then **Add to the mod** /
**Discard** for a draft, or **Delete this person** for someone already added.

**Import** is worth trying before **New**. It takes one of the game's own
people apart — pick a map, pick somebody standing on it, and their sprite,
position, movement and dialogue arrive as a copy you can change. The original
is untouched. People who battle are tagged **battles** in the list, with their
sight range shown, before you pick.

### Step 1 — NPC Name

One text box. The name is for you and for the mod's code; the player never
sees it. As you type, the line underneath shows what the engine will call
them and what their dialogue constant will be — type "Old Fisherman" and you
get `OLD_FISHERMAN` and `TEXT_OLD_FISHERMAN`.

Renaming later moves the display name, the id, the text constant and the
script behind it together, and works from the Maps screen too.

### Step 2 — NPC Sprite

Three slots. Each has **Select sprite** (a picker showing the game's own
decoded art, not a list of ids) and **Import custom sprite sheet**, plus
**Export** and **Clear** once something is in it.

| Slot | What it is |
| --- | --- |
| **Overworld sprite** | The one that walks around the map. Every NPC needs this one. |
| **Facing** | The picture shown head-on, in a battle. |
| **Back** | The picture drawn from behind. |

The overworld strip is shown cut into its frames beside the picker, with turn
arrows, because a sheet cut at the wrong height reads as nonsense there long
before it does in the game. If you fill either battle slot, an **In a battle**
panel appears showing both pictures on the screen they end up on, at the size,
place and colours the engine draws them in — a dashed box is a slot with
nothing in it yet.

**Gotcha:** only the overworld slot exports. An imported sheet ships as a PNG
in the zip with a `sprites:register` beside it. Facing and back are kept and
previewed, but they belong to the trainer record and start exporting when a
person can be battled.

### Step 3 — Location

**Which map** is a dropdown of every map — the game's own and your mod's.
Pick one and a mini-map appears; **tap the spot** where they should stand.
Red squares are cells the player cannot walk on.

Once placed, the hint reads *Standing at cell x, y*. Picking a map for someone
already in your mod moves them immediately; for a draft it only notes the
answer down, which is what keeps **Discard** a real way out right to the end.

If you pick one of the game's own maps, the step says so: your person is
appended to it, nothing vanilla is removed, and turning your mod off puts the
map back exactly as it was.

### Step 4 — Movement

Two dropdowns.

**Do they move?** — *Stands still* or *Wanders around*.

**Facing / roaming** — *faces down, never turns*, the four fixed directions,
or *roams any direction* / *roams up and down* / *roams left and right*.

**Gotcha:** if you set someone to wander but their sprite has no walking
frames, the step warns that they will slide rather than walk. Pick a sprite
marked as a walker, or have them stand still.

### Step 5 — What they say and do

This step edits nothing. Everything about what a person *is* and *does* lives
in the graph below; the step only reports what the graph currently adds up to
and scrolls you down to it. Its summary reads *no script yet*, *just talks*,
or *battles as <trainer class>*.

With no script yet, there is one button: **New Behavior**. Press it and a
script is created and opens in the docked editor. Talking is only the default
start — check a flag, give an item, start a battle, whatever this person
should actually do first.

With a script, the step tells you which text key the rows will ship as, gives
a count of blocks and rows, and offers **Jump to the node editor**, which
opens the dock if it is collapsed and scrolls to it.

### The unnumbered "This person" step

Only shows for someone already added. One line: *Exported as object N on
<map>*, or *Not on any map*.

### Add to the mod / Discard / Delete

**Add to the mod** stays greyed out until the draft has what it needs, and
says which of these is missing:

- *Give them a name first.*
- *Pick a map in step 3.*
- *Tap the map in step 3 to choose a spot.*

That last one is the one to know: **a person at cell -1,-1 is not a person.**
An NPC being invented is held aside until step 3 says where they stand, and
only lands in a map record when you press the button.

**Discard** asks *Throw this one away?* and then removes the draft, its
script, and any trainer record your mod made for it.

**Delete this person** removes someone already added, from the same spot in
the bar — so deleting does not mean scrolling to the bottom of a long form.

### The docked node editor

Everything about the graph is in [the node editor](#the-node-editor) section
below. Two things specific to the dock:

- **Drag the orange bar** to resize it. The bar is labelled *Node Editor*.
- **The chevron on its right** collapses and expands it.

### Making a trainer

There is no "this person is a trainer" block. A trainer is a **Start a battle**
block, wired up like anything else. Drop a bare one with nothing in front of
it and they fight every time — a legitimate choice, not a mistake.

For the usual challenge-then-rematch behaviour, wire an **Is flag set?** block
in front of it and a **Set flag** block after. The node search (right-click the
canvas) finds both.

**Start a battle** grows an extra **team** arrow when its kind is set to
`trainer`. Point it at a **Pokemon team** block — six rows, a species picker
and a level box each, drawn straight onto the block. A blank species row is
unused. The team is optional: **Start a battle**'s own `who` field is a plain
trainer picker, so you can point it at one of the game's 47 and leave their
data alone.

**Gotcha:** level is where it stops. Neither the `trainers` registry nor
`give_pokemon` has a moves field — the engine derives a Pokemon's battle moves
from its species' own learnset at that level. There is nothing to author per
trainer, only per species.

**Gotcha:** a mod trainer cannot have a **sight range**. Vanilla stores it per
trainer in a header the mod API cannot write to, so there is nowhere to put it.
Your trainer must be talked to.

---

## Pokemon Editor

**Getting there:** Start tab → *Pokemon Editor* card, or Content → **Pokemon**.

Seven numbered steps, same shape as the NPC screen. The toolbar is **Copy**,
**New**, the picker, then the draft or added controls.

**Copy** starts a new species from one of the game's own, which is usually
easier than starting blank.

| Step | What it asks | Notes |
| --- | --- | --- |
| **1. Name** | What it is called, and its **Pokedex number**. | The summary shows `#dex  ID`. |
| **2. How it looks** | Front and back battle pictures, **What it looks like on the map**, and a **Menu icon**. | Summary warns *no front picture yet* until you give it one. |
| **3. Type and stats** | **Type**, then **Base stats**, then **The other numbers**. | Summary shows the stat total. With game data, the step shows how your numbers compare with the game's own. |
| **4. Moves** | Its starting moves and its learnset by level. | Summary reads *N to start, M learned*. |
| **5. Evolution** | What it evolves into and how. | Summary reads *does not evolve* when empty. |
| **6. Its cry** | The sound it makes, built on the game's own cry synth. | |
| **7. Where it lives** | Its wild encounter slots. | Rewrites only the slots you ask for and leaves the rest of the area's wildlife alone. |

An unnumbered **This one is in your mod** step closes the column for a species
already added.

**Gotcha:** editing a species' learnset changes every Pokemon of that species
everywhere, including in vanilla trainers' parties. That is the engine's model,
not a choice the tool made.

---

## Move Editor

**Getting there:** Start tab → *Move Editor* card, or Content → **Moves**.

Seven numbered steps. Toolbar is **Copy**, **New**, the picker; once added you
also get **See the Lua** (jumps to the Scripts tab) and **Delete this move**.

Moves can be *patched* as well as created — step 1's summary reads *changing
the game's <ID>* when you are editing one of the game's own rather than
inventing a new one.

### Step 1 — Name

The name, and the id derived from it.

### Step 2 — Type

One dropdown. The summary shows the type and what it is effective against.

### Step 3 — Power, accuracy and PP

The three numbers, then **The extras**, which includes **Goes before or after
other moves** (priority). With game data, the step shows how your numbers
compare with the game's own moves.

### Step 4 — Move Effects

Gen 1 has no "25% chance to burn" field. It has sixty-eight named effects with
the odds baked into each one, so this step asks the question the other way
round.

**Besides damage, it…** has three answers:

| Answer | What happens |
| --- | --- |
| **Nothing** | A plain attack. Most of the game's moves are this, and it is right more often than it looks. |
| **Status Effect** | You say which condition and how often; Oak's Lab finds the vanilla effect that already means that, or writes one longhand if none does. Which of the two it did is shown, not hidden. |
| **Other Move Effect** | Pick from the engine's own effects by name. Costs nothing and behaves the way players already expect. |

**Gotcha:** a move with **no power never reaches its side effect** — the engine
only rolls those after damage. The step warns you when power is 0 and the
chance is under 100%.

**Gotcha:** a secondary status never lands when the move's type matches one of
the target's types. A Fire move cannot burn a Fire-type at any chance. The step
states this where it applies.

### Step 5 — What it looks like

The flash across the battle screen. **Where it comes from** has two answers:

**"one the game already has"** — **Borrow which one** picks from the game's
own animations, and it plays right there on a mock battle screen. Leaving it
blank is allowed but warned about: the move then does its damage in silence
with an empty screen, because the engine has no fallback animation. There is
also **Export the game's art**, which replays the animation and photographs it
frame by frame into a strip — the starting point for painting your own version.

**"one I paint myself"** — a strip of frames that plays 1 through N in order,
at a spot you pick by tapping the mock screen or typing the position number.

**Gotcha:** this step needs game data. Without it the step says so and stops.

**Gotcha:** a painted strip plays exactly as painted in every COLORS display
mode, because it draws outside the game's own picture pipeline and never gets
recoloured by it.

### Step 6 — What it sounds like

Built on the same synth the Pokemon cries use.

### Step 7 — Who can use it

Which species learn it.

**Gotcha:** there is deliberately no step for field moves. Gen 1 checks for
Cut, Surf and the rest by move id in eight hardcoded places, with no field and
no event a mod can answer, so a new move cannot become a ninth field move.
Patching a vanilla move is still possible from **All records**.

---

## Item Editor

**Getting there:** Start tab → *Item Editor* card, or Content → **Items**.

Five numbered steps. Toolbar is **Copy**, **New**, the picker; once added,
**See the Lua** and **Delete**.

### Step 1 — Name

Typed in, uppercased, capped at twenty characters — Gen 1 draws item names in
a twenty-character bag list, so anything much longer than FULL RESTORE gets cut
off. The line below shows the id the engine will use.

While it is a draft, this step also tells you whether **Add to the mod** is
ready or what is still missing.

### Step 2 — What it does

The important one, and not a single-choice question. Items can combine
behaviours, so this is an **ordered list of rows**: pick a behaviour from the
dropdown, press **+ Another behavior** to add more, reorder with the **▲/▼**
arrows, remove with the row's own button.

Oak's Lab writes one `use()` function that tries each row top to bottom until
one applies. **Order is a real decision, not cosmetic** — the game's own FULL
RESTORE is exactly this shape (try a full heal; only when the target is already
at full HP does it fall through to curing a status), which is why copying it
puts healing above curing.

The behaviours on offer:

| Group | Rows |
| --- | --- |
| **Healing** | Restores some HP · Restores all HP · Cures a status condition · Revives a fainted Pokemon, to half HP · Revives a fainted Pokemon, to full HP |
| **PP** | Restores some PP to one move · Restores all PP to one move · Restores some PP to every move · Restores all PP to every move · Permanently raises a move's max PP |
| **Growth** | Raises its level (Rare Candy) |
| **Evolution** | Matches an evolution stone |
| **Moves** | Teaches a move, TM/HM style |
| **Catching** | Throws it as a Poke Ball |

**Gotcha, and the important one: adding no rows at all is a valid and common
answer.** It gives you a plain key item, which is the safest new item there is,
because nothing in the engine is hardcoded against a new id. The step says so
in place.

**Gotcha:** a copy of POTION under a new id heals nothing. There is no
`healAmount` field the engine reads generically — almost everything an item
"does" in Gen 1 is hardcoded to its own id string. That is exactly why this
step exists.

**Gotcha:** mixing **Throws it as a Poke Ball** into a list that also heals
makes the bag ask "use on which Pokemon?" even on the turns it just gets
thrown. A ball on its own does not ask. That is a real rough edge of combining
the two, not something the tool can smooth over.

**Not offered on purpose:** a vitamin — a permanent stat-exp booster like
CALCIUM. The vanilla item recalculates stats through an engine module outside
the documented context a mod's Lua can reach, and guessing at the formula
risks drifting from the real one. PP restoratives and PP UP are offered;
neither touches stats.

### Step 3 — Price

**Buy price** as a number. A mart sells at this price and buys back at half —
both come from this one field. With game data, the step lists the closest
vanilla items by price so you have something to calibrate against.

**This is a key item** is a checkbox; ticking it zeroes and disables the price.
It is the one field that actually controls tossing and selling.

**Gotcha:** the schema also lists a `tossable` field. It is checked nowhere in
this engine, so Oak's Lab deliberately does not offer it as a toggle that would
silently do nothing.

### Step 4 — Where it's sold

A shop in Gen 1 is a person, not a building: a clerk's `TEXT_` constant carries
the list of what they sell. This step lists every shopkeeper — the game's own
plus any your mod has already given a stock list — and lets you add your item
to one.

Your mod appends to their stock, so turning it off puts the counter back
exactly as it was.

**Gotcha:** needs game data. Without it the step says *No shop data in this
copy of Oak's Lab — regenerate gamedata.json to pick a shopkeeper.*

### Step 5 — Where it's found

An item lying on the ground is a Poke Ball on the map, the same way every one
of the game's own is stored. **Put one on a map** is a map picker; then tap the
spot. Placements are listed above with a **Remove** button each.

Oak's Lab places the ball and writes the script behind it: pick it up once, and
it is gone for good. Each placement gets its own object name, text constant and
flag, so two of the same item on one map do not hide each other.

**Gotcha:** name the item first. The ball is named after it, and tapping the
map before naming gets you *Give the item a name first*.

**Gotcha:** a ball on a cell the player cannot walk on is fine — it can still
be reached from beside it, the way the game's own hidden-corner items are.

**Gotcha:** items carry no flag field of their own. There is no such field
anywhere in the registry. The two things people usually mean by that are
scripts, not fields: `check_item` gates a door or path with no flag at all (the
Card Key / S.S. Anne ticket pattern — a sign or person stands at the doorway,
since the warp tile itself has no condition), and `check_flag` → `give_item` →
`set_flag` handles a one-time pickup or quest reward. Build either on the
Scripts side.

---

## Map Editor

**Getting there:** Start tab → *Map Editor* card, or Content → **Maps**.

Three panes: tools on the left, the map canvas in the middle, an inspector on
the right. This workspace is not a stepped column — it is a paint program.

### Making a map

**+ New** opens one dialog with **What are you making**:

| Mode | What you get |
| --- | --- |
| **a brand new map** | Name, **Tileset**, **Width (blocks)** and **Height (blocks)**. One block is four tiles square; six by six is about one screen. |
| **a copy of an existing map, under a new id** | The whole map duplicated under a new id, yours to change. |
| **changes to an existing map** | A patch record — your additions on top of a vanilla map. |

A new map is a draft until you press **Add to the mod** in the bar above the
canvas. The only thing blocking it is *Give it an id first*.

If you have several maps in progress, the tool asks whether to **Add all N**
together (useful when they warp into each other) or **Just this one**.

### The tools

Three groups down the left.

**Textures**

| Tool | What it does |
| --- | --- |
| **Paint** | Drag to lay blocks down. |
| **Eye drop** | Click a cell to pick up its block as the new brush, then switch straight back to Paint on its own. |
| **Select** | Drag to select an area of blocks. Drag inside the selection to move it. |

**Objects**

| Tool | What it does |
| --- | --- |
| **Warp** | Click to drop a door. |
| **Warp tile** | Click a 16px cell to mark its tile as a warp trigger. |
| **Sign** | Click to drop a sign. |
| **NPC** | Click to drop a person. |
| **Select** | Click a door, sign or person to edit it, or drag it to move it. |
| **Remove** | Click a door, sign or person to delete it. |

**Gotcha:** placing a door and flagging the trigger are two separate actions. A
warp only fires from a cell whose tile is flagged with **Warp tile**.

**Collision**

| Tool | What it does |
| --- | --- |
| **Block off** | Click a 16px cell to make it solid. |
| **Open up** | Click a 16px cell to open it up, even if the art says otherwise. |
| **Clear** | Click a 16px cell to clear its override, back to whatever the art itself says. |

Whichever tool is selected, the hint line underneath the buttons says what it
does. Two checkboxes sit below: **Shade blocked cells** (on by default) and
**Show grid**.

### Blocks, tilesets and zone art

**Import sprite sheet** and **Export sprite sheet** sit above the tileset
picker. Importing asks for a **Tileset id** and takes a PNG cut into 32x32
blocks — **every block starts solid**, so use the Collision tools once it is on
the map to open up ground the player can walk on.

| Control | What it does |
| --- | --- |
| **Mix tilesets** (on by default) | Each block cell remembers which tileset it came from; on export every tile the map actually used is composited into one new atlas. Costs nothing when unused — a map that never leaves one tileset ships no PNG at all. |
| **Sub-tiles (quadrants)** (off) | Splits each 32x32 block into four 16x16 quadrants you can paint independently. Click a *quarter* of a block in the palette to load the brush. |
| **Outside fill** | What the player sees walking off the edge of the map — tiled forever, so pick something that repeats cleanly. |
| **Zone art** | Export the exact sheet the map ships, paint over it, and import it back. |

**Gotcha:** the collision tools quietly turn **Mix tilesets** on, because they
need the map to own its tileset. A painted-solid cell is drawn *darker* than
one the tileset was already blocking, because the first costs a duplicated tile
and the second is free — worth being able to tell apart.

**Gotcha:** importing zone art replaces the **pixels only** and deliberately
never re-reads the grid. Re-deriving blocks from an edited image would throw
your collision work away, since two tiles that now look different might still
be the walkable/solid pair the exporter minted.

### The inspector

On the right, with **Show coordinates** at the top. Select a door, sign or
person with the Objects **Select** tool and its settings appear here. **Map
index** is here too — vanilla tops out at 247, so keep new maps at 1000+.

**Gotcha:** editing terrain ships the whole `blocks` array, because that is the
only shape the registry takes. Adding *objects* to a vanilla map only writes
what you added. The inspector says which is happening.

---

## The node editor

**Getting there:** it is docked under the **NPC** workspace. Drag its orange
bar to resize, or use the chevron to collapse it.

Three panes: the block palette on the left, the canvas in the middle, and the
inspector on the right.

### Adding blocks

The left palette holds the common blocks, grouped by category. **Show every
verb** expands it to all of them.

**Right-click anywhere on empty canvas** to search all 65 blocks by name or
category and drop one exactly where you pointed. This is the main way to reach
anything that is not a starter block. The canvas fills its whole pane, so the
right-click works in empty space and not only near existing nodes.

### Wiring and editing

Blocks connect through named ports drawn as arrows off their edges — `then`,
the false side of a branch, and a `team` arrow on **Start a battle** when its
kind is `trainer`.

Select a block and the inspector on the right shows:

- **This block** — its own settings. *No settings.* when it has none.
- **Goes to** — its exits and where each one leads.
- **Rows this makes** — the actual compiled rows, so you can see the Lua
  taking shape as you wire.
- **Start here** and **Delete** buttons.

**Start here** makes the selected block where the graph begins. Any block can
be, not just the one it started with.

**Delete** or **Backspace** with the canvas focused removes the selected block.

### The Pokemon team block

**Pokemon team** is the one block that is data rather than a step. Six rows,
a species picker and a level box each, drawn straight onto the block. A blank
species row is unused. It has no exits, and it is the one block that cannot be
**Start here** — it is pointed at, not run.

---

## All records

**Getting there:** Content → **All records**, set apart on the right.

The generic registry editor: every field of every registry the engine has,
generated from the schema pack rather than hand-written. **+ Add** creates a
record; the middle pane is its form; the right pane is the reference
documentation for that registry.

This is where you patch anything the five workspaces do not cover — a vanilla
move's power, a Pokemon's catch rate, a trainer's party.

**Gotcha:** maps and map scripts are deliberately not offered here. They have
their own screens.

**Gotcha:** fields the engine types as `function` are shown but not editable.
Those are real Lua closures and stay that way — the exported `main.lua` is
where you add them.

---

## Scripts tab

**Getting there:** the **Scripts** tab in the header.

Two panes. On the left, **Files** — every file your mod will ship, with its
size. On the right, a read-only preview of whichever you select, with the Lua
syntax-highlighted. Imported art shows its byte count instead: it ships in the
zip as-is.

Nothing here feeds back into your project. It is entirely optional reading —
it exists so `main.lua` is one tab away from the block editor rather than
something you only meet after exporting.

---

## Export tab

**Getting there:** the **Export** tab in the header.

Seven numbered steps, the same shape as the content workspaces.

| Step | What it asks |
| --- | --- |
| **1. Mod name** | *What's it called?* The line below shows the folder and manifest id derived from it. |
| **2. Author** | *Who's making this?* |
| **3. Version** | semver — major.minor.patch, e.g. `0.1.0`. The launcher compares versions with it. |
| **4. Description** | One line the mod manager shows. |
| **5. Problems** | The lint results. Summary reads *all clear* or *N to fix*. |
| **6. Export** | **Download mod .zip**, and a list of exactly what is inside. |
| **7. GitHub** | Disabled. Auto-updates are not wired up. |

### Step 5, Problems

The fast local half of validation, run continuously. It catches things like a
mod id with illegal characters, a version that is not semver, a missing
description, drafts you have not added yet, and references to records that do
not exist.

**Gotcha:** a draft you forgot to add is a *problem*, not a silent omission.
The lint names it and tells you it will not ship until you press **Add to the
mod**.

### Step 6, Export

**Download mod .zip** gives you `<id>-<version>.zip` with the files at the
archive root — the shape the launcher's Import, Update and Versions features
read. Every mod ships at least `manifest.json`, `main.lua` and a generated
`README.md`; imported sprites, cries, move animations and tileset atlases are
added as their own files alongside.

If the lint found anything serious, the button asks *N problem(s) found.
Download anyway?* first. You can say yes — it is a warning, not a gate.

**Gotcha:** the Export tab's lint is not the real gate. `modkit.py` is, and it
is meant to run in CI.

**Gotcha:** Oak's Lab does not publish. It does not touch your GitHub account,
and step 7 is a disabled placeholder.

---

# How this works internally

Everything below is *why*, not *how to*. It is the record of what in the
engine forced each decision, kept because the constraints are not obvious and
rediscovering them is expensive.

<details>
<summary><b>The schema pack is the spine</b></summary>

Nothing about pokemon, moves, items or trainers is hardcoded. The engine's
[registry reference](https://github.com/bryanthaboi/gen1recomp/wiki/Reference-Registries)
is itself generated from `src/mods/Schemas.lua`, so parsing it gives a schema
that cannot drift from the engine:

```
registries : 46 (191 fields)
commands   : 65 (30 curated)
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

</details>

<details>
<summary><b>Nothing asks you to know an id</b></summary>

Every field that wants an engine id is a dropdown, never a box you have to type
`OPP_BUG_CATCHER` into from memory. `tools/extract-gamedata.mjs` parses the
engine's own decoded data cache with a small exact parser for the
pretty-printer's Lua subset, and produces id lists for 17 registries:

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

</details>

<details>
<summary><b>People are a workspace, not a wizard</b></summary>

The NPC workspace is one scrolling column of numbered steps with the node
editor docked underneath. The point is that nothing is a one-shot: a wizard
asks its questions once and then scatters the answers across three tabs, where
this keeps all of them on screen and lets you change any of them in any order,
watching the graph the whole time.

Steps 1–4 write to the same map object the Maps tab has always edited, so
nothing about the export changed. Renaming works from either screen and moves
the display name, the `SHOUTY_ID`, the `TEXT_` constant and the script behind
it together.

Step 5 edits nothing, because everything about what a person *is* and *does*
lives in the graph.

An NPC being invented is held aside until step 3 says where they stand — a
person at cell `-1,-1` is not a person — and only lands in a map record when
you press **Add to the mod**. Until then **Discard** is a real way out.

</details>

<details>
<summary><b>A trainer is just an ordinary block</b></summary>

There is no special "this person is a trainer" block. A trainer is a **Start a
battle** block, wired up like anything else — because a mod NPC does not need
to be built the way a vanilla one is stored internally to behave the same way
at the table. Vanilla gets its challenge/rematch switch for free from a trainer
header the mod API cannot write to (checked: no `trainer_headers` registry, and
`field` does not carry it either), so a mod trainer earns the same switch
honestly, with the blocks already on the canvas:

```
[Is flag set? BEAT_ROUTE_KID]
  YES ─► [Say "You're strong!"]
  NO  ─► [Say "Let's battle!"] ─► [save end battle text: "I lost!"] ─► [Start a battle]
                                                                              │ then
                                                                    [Did player win?]
                                                                              │ YES
                                                                       [Set flag BEAT_ROUTE_KID]
```

Nothing forces this shape. Drop a bare **Start a battle** block with nothing in
front of it and it fights every single time — that is a legitimate choice too,
not a mistake the tool corrects.

**The Pokemon team block.** **Start a battle** grows an extra **team** arrow
when its kind is set to `trainer`. Point it at a **Pokemon team** block — six
rows, species and level each, drawn onto the block itself. No sub-blocks to
place or wire.

Level is where it stops, and that stop is a real one: neither the `trainers`
registry nor `give_pokemon` has a moves field anywhere. The engine always
derives a Pokemon's battle moves from its species' own learnset at that level,
so there is nothing to author per trainer — only per species, by editing that
species' learnset, which then changes every Pokemon of that species everywhere.

The team is optional. **Start a battle**'s own `who` field is a plain trainer
picker — point it straight at one of the game's 47 or one of this mod's own, no
team block required. Connecting a team only touches a trainer this mod made
(`isOwnTrainer`); pointing `who` at an existing vanilla trainer with no team
connected leaves that trainer's data alone.

</details>

<details>
<summary><b>Import takes one of the game's own people apart</b></summary>

Pick a map, pick somebody standing on it, and their sprite, position, movement
and **dialogue rebuilt as nodes** land in the workspace as a copy you can
change. The original is untouched. This is the one thing a tutorial cannot do:
"how does the game do it?" and "how do I do it?" end up being the same picture.

The words come from resolving the chain the ROM actually uses — map object →
`TEXT_*` constant → `text_pointers.lua` → `text.lua` — and the `\012` control
code that starts a fresh text box becomes a new node, which is exactly where
the tool would have put one.

Trainers import as trainers, with all three of their lines. Their words are
**not** in the text table — their `text_pointers` entry is `asm = true` with no
string, which is why they used to import saying "...". The real text is in
`trainer_headers.lua`, already split before / on-defeat / after, landing on the
three blocks one-for-one. Vanilla people who battle are tagged **battles** in
the import list, with their sight range shown, before you pick.

A copy never inherits the original's `TEXT_` constant. Registering
`talk.TEXT_PALLETTOWN_FISHER` on Pallet Town would rewrite what the *real*
fisher says instead of giving your person words, and the obvious name for a
copy walks straight into it, so the constant is de-duplicated against every
vanilla one.

One thing the tool cannot give a mod trainer: **sight range**. Vanilla stores
it per trainer in the header (`0` = must be talked to, `2`–`4` = spots you that
far), and with headers closed to mods there is nowhere to write it.

</details>

<details>
<summary><b>Scripts are a graph already</b></summary>

A gen1recomp script is an array of rows, `{ "verb", arg1, ... }`, with `label`
rows as jump targets. That is a graph written down, so the node editor is a
serialiser, not a code generator. Each node is one row; each edge is
fall-through or a jump.

The exception is **Pokemon team**, which describes a party rather than a step —
it emits no row. `rowFor` skips it via `mf: true` in `MF_VERBS`;
`syncBattleTeams` folds its six-row table into the trainers registry, and into
the `who`/`levelOrParty` args of whichever **Start a battle** block points at
it, right before the compiler reads either.

Edges are named ports rather than a fixed `next`/`no` pair: `portsOf(node)`
returns `{key, label, cls}` for each exit, and rendering, wiring, arranging,
deletion and reachability all read from it. `next` and `no` are just two of the
names — `start_battle` gains a `team` port when its kind is `trainer`, patched
onto the real engine verb rather than invented as a new kind of block.

The compiler mints labels only where they are needed — a node with more than
one way in, or the false side of a branch — so a straight conversation compiles
to straight rows. The talking-NPC recipe produces:

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
and right-clicking anywhere on the canvas searches all 65 by name or category
and drops one exactly where you pointed. The canvas fills its whole pane, so
the right-click works in empty space and not only near existing nodes.

</details>

<details>
<summary><b>Move effects, animation playback and sound</b></summary>

Three of the Moves workspace's seven steps are more than a form, each because
the engine's own data made the honest answer awkward.

**The status chance (step 4).** Gen 1 has no "30% chance to burn" field. It has
sixty-eight named effects, four of which happen to burn things, and the odds
are baked into each one — `BURN_SIDE_EFFECT1` rolls 26 out of 256,
`BURN_SIDE_EFFECT2` rolls 77. So the step asks the question a person actually
has (which condition, how often) and resolves it: if the game already means
that, it names the vanilla effect and the mod ships no code at all; if it does
not, Oak's Lab writes the effect, longhand, as the engine's own `statusSide`
written out. Which of the two it did is shown, not hidden. The type rule that
catches everybody out — a secondary status never lands when the move's type
matches one of the target's — is stated where it applies.

**The animation (step 5) plays, two ways.** Borrowing one of the game's 202
plays through `compileAnim`, a port of the engine's own `AnimPlayer:start` —
same OAM buffer simulation, same four frame-block modes — so what plays in the
browser is what plays in the game, drawn on the real battle screen because
these tiles are transparent-on-white and invisible on anything else.

Painting your own is a second, deliberately simpler path: a strip of frames
(reusing the NPC sprite-strip importer's own "filmstrip" mode) that plays 1
through N in order, at a spot chosen by tapping the mock screen or typing the
position number directly. Borrowing one of the game's animations (or exporting
its art) states which of the 177 it draws at, so a painted replacement can be
told the same number rather than eyeballing a click against a picture with
nothing to compare it to.

"Export the game's art" replays any of the 202 and photographs it frame by
frame, handing back the picture as it appears on screen — not the raw tile
sheet, which is unordered 8x8 cells shared by every animation. The strip comes
out as a boxed grid: a 1px magenta guide line around and between every cell, so
the edges of each frame are visible while painting. Those guides are also how
the import reads the cells back — `guideGridBoxes` takes the spans between
fully-guide-coloured rows and columns, then strips the magenta — so the sheet
describes its own grid and survives a round trip through a paint program that
knows nothing about any of this. Sheets without guides fall back to island
detection. Frames the game holds still are exported once, and how long each was
held is reported, since that is the one thing a strip cannot carry.

It does not go through `battle_anims` at all — there is no registry route for a
new tile *arrangement* (only for borrowing the game's own, or registering a
tile sheet), so a hand-painted strip cannot become a content record no matter
how it is shaped. Instead it exports as a small shared Lua helper:
`mod.events:on("battle.move_used", ...)` starts playback and holds the turn
open with `battle:waitNext` (the same call the engine's own status effects
use); `mod.hooks:wrap("battle.overlay", ...)` draws the current frame once a
frame, after the whole battle screen has finished compositing. One helper is
shared by every move using this — only the per-move table entry grows. The
trade a painted strip makes for that freedom: it plays exactly as painted in
every COLORS display mode, since drawing outside the game's own picture
pipeline means never being recoloured by it.

There is deliberately no step for the overworld (Cut, Surf and friends): Gen 1
checks for them by move id in eight hardcoded places in `OverworldController`,
with no field and no event a mod can answer, so a new move cannot become a
ninth field move — a step whose whole content was "no, but you can patch an
existing one over" was worse than no step.

Sound reuses the cry synth, because a move's `anim = {sound, pitch, tempo}` is
the same arrangement as a cry's `{base, pitch, length}` over the same
three-bytes-per-channel headers. `src/cry.js` gained the seven opcodes battle
sound effects reach for beyond the five a cry uses — a frequency sweep above
all, which is the descending boop behind half the hit sounds. No cry program
touches any of them, so all 154 render byte-identically to before.

</details>

<details>
<summary><b>Items combine behaviours, and the one genuine gap</b></summary>

Almost everything an item "does" in Gen 1 turns out to be hardcoded to its own
id string in a ~600-line waterfall (`engine/items/item_effects.asm`, ported
nearly line for line into `src/inventory/ItemEffects.lua`), rather than carried
in a field. A copy of POTION under a new id heals nothing at all — there is no
`healAmount` field the engine reads generically, the same trap as a Sonicboom
copy dealing no damage, except moves at least have `fixedDamage` to backfill
and items mostly don't.

**"What it does" is a list, not a single choice, because items can combine
behaviours.** The obvious question ("can it heal AND be an evolution stone?")
turns out to already have a vanilla precedent: FULL RESTORE isn't one effect,
it's two — try healing to full, and only when the target is *already* at full
HP does it fall through to curing a status instead. So the step is an ordered
list of rows, and Oak's Lab writes one `item_effects.use()` that tries each row
top to bottom, falling through until one applies. Order is a real, user-set
decision (reordered with the ▲/▼ buttons next to each), not cosmetic — a
"heals or evolves" item genuinely needs the modder to say which one wins when
both could apply. Adding no rows at all is a valid, common answer too — that's
a plain key item, still the safest starting point since nothing in the engine
is hardcoded against a new id. `machine` (TM/HM) is the one behaviour that is
ALSO a native field in its own right, kept alongside the generated Lua for
metadata even when combined with something else, since the native dispatch path
is bypassed the moment an item carries its own `effect`.

**A new catchable Poke Ball turns out to be possible**, which looked like a
dead end on first reading. `ItemEffects.use` only returns the "ball" signal
`BagMenu` needs to throw one for a hardcoded five-id list — but that check sits
inside the *hardcoded* half of `ItemEffects.use`, which an item carrying its own
`effect` never reaches at all. A one-line effect
(`use = function(ctx) return "ball" end`) is the whole trick: BagMenu reads back
the string "ball" and throws using the item's own id, and `balls` (catch math:
`randMax`, `hpFactor`, `wobbleFactor`, `tossAnim`) is a real registry keyed
per-id with no such hardcoded gate.

`needsTarget` is one value per item, decided by whether any behaviour in the
list needs a party-member target: a ball alone sets it false, but mixing a ball
into a list that also heals has to set it true so the healing half still works.
That is a real, small rough edge of combining the two, not something this tool
can smooth over.

**A vitamin (a permanent stat-exp booster, like CALCIUM) is a genuine gap, on
purpose.** The vanilla item recalculates the Pokemon's stats afterward through
`src/pokemon/Stats.lua`, an engine module outside the documented `ctx` a mod's
own Lua can reach — the same discipline `move_effects` generation already keeps
to (`ctx.inflict`/`ctx.rng`, nothing reached by `require`). Rather than guess at
reproducing the formula by hand and risk it drifting from the real one, this
category isn't offered; PP restoratives and PP UP are (neither touches stats),
and the gap is stated on the step rather than papered over.

**Items carry no flag of their own** — there is no such field anywhere in the
registry. The two things people usually mean by that are working scripts
instead of a fake field: `check_item` gates a door or path with no flag at all
(the vanilla Card Key / S.S. Anne ticket pattern — a sign or person stands at
the doorway, since the warp tile itself has no condition of its own), and
`check_flag` → `give_item` → `set_flag` handles a one-time pickup or quest
reward.

**Shops are people.** A shop in Gen 1 is a map's `text_pointers` entry carrying
a `mart` list, opened by an `open_mart` script block — so "which shop sells
this" really is a question about which *person* sells it, and the step picks a
clerk by their `TEXT_` constant, which is how the engine identifies them.

</details>

<details>
<summary><b>Maps, and the zone engine bolted into them</b></summary>

Block painting, warps, signs and NPCs, on the engine's real coordinate model: a
block is 32x32 px = 4x4 tiles, `blocks` is row-major `width*height`, and
entities sit on the 16px cell grid.

Passability follows `src/world/Map.lua`: a cell is walkable when its
**bottom-left** 8x8 tile is in the tileset's `walkable` list. Checked against
all 222 vanilla maps — 94% of the 916 vanilla NPCs stand on cells this
implementation calls walkable, which matches the engine's own figure.

Patching a vanilla map only writes what you added, via the `__append` wrapper,
so vanilla entries survive. Editing terrain ships the whole `blocks` array,
because that is the only shape the registry takes; the inspector says so.

`src/zone.js` brings the standalone
[Gen1 Zone Editor](https://github.com/bryanthaboi/gen1recomp)'s authoring power
into this tab, adapted to Oak's Lab's own map model rather than replacing it —
a map is still the same `{verb, id, rec}` the NPC workspace, the item balls and
the linter all already read, so nothing else had to change. It adds three
things, and one line of engine source decides the shape of all of them
(`src/world/Map.lua:221`):

```lua
return self.walkable[self:cellTile(cx, cy)] or false
```

Walkability is a property of the **tile index**, looked up in the tileset's
`walkable` list. It is not per-cell, and there is no per-map collision layer
anywhere in the registry.

**Mixing tilesets is on by default.** Each block cell remembers which tileset it
came from, and on export every distinct tile the map actually used is
composited into one new atlas PNG with the blocks re-indexed against it. It is
the default because it costs nothing when unused: a map that never leaves one
tileset merges back to exactly that tileset and ships no PNG at all. What it
removes is the dead end where a first map wants one tree from FOREST and the
whole thing is already committed to CAVERN.

**Sub-tiles are opt-in.** Splitting each 32x32 block into four 16x16 quadrants
that can be painted independently is a sharper tool than most maps need, and it
multiplies the block count in the compounded atlas, so it stays a toggle.

**Collision is painted, not just shaded.** Because of the line above, "make this
one cell solid" cannot be stored on the cell — so it isn't. The exporter mints a
**second copy of that tile** in the compounded atlas: identical pixels, a
different index, and only one of the two listed in `walkable`. The cell points
at whichever copy it needs. That is why the two collision tools quietly turn
tileset-mixing on (they need the map to own its tileset), and why the overlay
draws a painted-solid cell darker than one the tileset was already blocking —
the second is a decision that costs a duplicated tile, and worth being able to
see. Asking a cell for what its tile already does clears the override rather
than recording a redundant one, so the atlas only grows for cells that
genuinely needed it.

**The art round-trips.** Export gives you the exact sheet the map ships; paint
over it, keep every tile in its own 8x8 square, and import it back. The import
replaces the **pixels only** and deliberately never re-reads the grid:
re-deriving blocks from an edited image would throw the collision work away,
since two tiles that now look different might still be the walkable/solid pair
the painter minted.

</details>

<details>
<summary><b>Everything can be deleted</b></summary>

Content records, scripts and maps each have a delete on their list row.
Deleting is not just a splice:

- Deleting a **place** offers to take back the door it punched into the vanilla
  map, and drops the patch record entirely if that door was the only thing in
  it. Otherwise the mod ships a door to nowhere.
- Deleting a **script** offers to unlink whoever was pointing at it, rather than
  leaving characters talking to a TEXT constant that no longer exists.

Editing a vanilla map says so, plainly, at the point you do it: your additions
are appended, nothing vanilla is removed, disabling the mod puts it back — but
another mod rewriting the same map could clash.

</details>

<details>
<summary><b>Packaging it for Android — deferred, but the shape is settled</b></summary>

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
- **Touch already works.** Every canvas and drag handler is `pointerdown` /
  `pointermove`. There is not one `mousedown` in `src/`.
- **`file://` is already survived.** `Store` in `core.js` probes `localStorage`
  and falls back to memory when the property access itself throws — the exact
  failure mode of a page opened from a file with site data blocked.

**What needs a bridge is three seams, and no more:**

```
core.js  download()           blob URL + <a download>  -- the one that breaks
core.js  Store                localStorage, already fallback-guarded
ui.js    <input type="file">  needs onShowFileChooser wired
```

`<a download>` on a blob URL is the reliable Android WebView failure; it wants a
`DownloadListener` or a small JS bridge. Keeping every save routed through that
one function is what makes the port a one-file change — a stray `<a download>`
elsewhere is what would turn it into a hunt.

**The one thing that would force a real rewrite** is a phone build having to
derive `gamedata.json` from a raw ROM itself. `tools/extract-gamedata.mjs`
parses the engine's *already-decoded* cache, not the ROM, so that is not a small
port — it is the engine's whole extraction pipeline in JS.

What is genuinely left is layout: this is a multi-pane desktop screen and a
phone is not. That is CSS — the layer deliberately kept open — and it is the
right kind of work to defer, because it wants a real device in hand rather than
a guess.

</details>

---

# Building

```
node build.mjs               # local build, game data embedded
node build.mjs --no-gamedata # shareable build, no ROM-derived bytes
```

`build.mjs` concatenates `src/` into a single `oaks-lab.html` at the project
root. That file is gitignored — the Release asset is the distribution
mechanism, not a committed file.

Do not open `src/app.html` directly. It is the template, not the app: its
content is substituted in at build time, so opening it gives you a page that
looks right and does nothing. It now says so rather than failing silently.

`tools/serve.mjs` exists only for previewing in a desktop browser that blocks
`file://`. The app itself never needs it.

## Game data

`data/gamedata.json` (maps, tilesets, tile sheets, sprite art and vanilla
dialogue) is decoded from the player's own ROM, and is **not committed to this
repo** (see `.gitignore`).

**Game data is embedded when the file is built, not loaded at runtime.**
`node build.mjs` bakes it in; `node build.mjs --no-gamedata` builds a
shareable file without it. Which one you have decides what the tool can do —
see [Before you start: game data](#before-you-start-game-data).

Regenerate it locally with:

```
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

## How the source is laid out

```
tools/fetch-wiki.mjs          refresh data/wiki/*.md from the engine wiki
tools/build-schema-pack.mjs   data/wiki/*.md      -> data/schema-pack.json
tools/lua-data.mjs            parser for the engine's generated .lua tables
tools/extract-gamedata.mjs    ROM cache + zone_editor -> data/gamedata.json
tools/extract-copy.mjs        src/*.js UI text        -> copy.md, for hand-editing
tools/apply-copy.mjs          copy.md (edited)         -> back into src/*.js
src/app.html                  markup, styles, placeholders
src/core.js                   project state, Lua emitter, form generator, zip
src/script.js                 node editor, graph -> rows compiler
src/map.js                    block painting, warps, signs, NPCs, mini-maps
src/zone.js                   compound tilesets, sub-tiles, painted collision
src/wizard.js                 stepped-dialog helper and the deletion cascades
src/npc.js                    the NPC workspace and its docked node editor
src/mon.js                    the Pokemon workspace
src/move.js                   the Moves workspace
src/item.js                   the Items workspace
src/sprite.js                 sprite pickers and importers
src/cry.js                    cry/SFX synth, shared by cries and move sound
src/ui.js                     tabs, Start guide, Content tab, Export tab
build.mjs                     concatenates the above into oaks-lab.html
```

---

# What it does not do

- **Hooks and events.** Those are real Lua closures and stay that way. Fields
  the engine types as `function` are shown in forms but not editable; the
  exported `main.lua` is where you add them.
- **Validate like the engine does.** The Export tab's lint is the fast local
  half. `modkit.py` is the real gate and is meant to run in CI.
- **Publish.** Oak's Lab does not touch your GitHub account. The zip it
  produces is already the right shape — `<id>-<version>.zip`, files at the
  archive root — which is what the launcher's Import, Update and Versions
  features read.
- **Playtest.** The engine is LÖVE and desktop-only. Author on a phone, play on
  a PC.
- **Round-trip an existing mod.** Importing script rows back into the graph is
  not built yet.

# Next

- The Maps workspace, redone the way the other four were.
- A ninth field move, which needs Lua the overworld can call rather than a
  content record.
- GitHub write path — commit, workflow, tag, release, index PR.
- Round-trip import: read an existing mod's script rows back into the graph.
  The compiler is already a bijection, so this is a parser, not a rewrite. NPC
  import already does the vanilla half of this from the ROM's text tables.
- Art: facing and back sprites through the trainer record, and the
  asset-transform declarations that go with imported sheets.
- The two Start tab tutorial cards, currently marked *Coming soon*.

# Editing the UI's own text

Every heading, hint, label and warning in Oak's Lab lives as a string inside
`src/*.js`. `tools/extract-copy.mjs` / `tools/apply-copy.mjs` pull it all into
one `copy.md` to edit in a normal text editor and put it back — see
[tools/README.md](tools/README.md) for the full process.

# License

[Oak's Lab License](LICENSE) — free to use, copy, modify and distribute. The
one condition: a mod made with Oak's Lab should credit Oak's Lab and its
creator, Nezara, somewhere in its own credits — e.g. "Made with Oak's Lab by
Nezara".
