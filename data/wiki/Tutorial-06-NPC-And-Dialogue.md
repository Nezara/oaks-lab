# Tutorial 06 — NPC and dialogue

**Goal.** Place a new NPC on an existing map and give it a branching
conversation.

**Prerequisites.** Tutorial 05;
[Reference: Script Commands](Reference-Commands).

**Files created.**

```text
mods/tutorial_06_npc/
├── manifest.json
└── main.lua
```

## Steps

1. **Add the NPC to the map record.** Map objects are data — the same
   shape the importer emits (`index`, `x`, `y`, `sprite`, `movement`,
   `range`, `text`). Append one to Pallet Town with a wrapper so the
   vanilla objects stay:

   <!-- snippet: run -->
   ```lua
   return function(mod)
     mod.content.maps:patch("PALLET_TOWN", {
       objects = { __append = {
         { index = 90, x = 8, y = 7,
           sprite = "SPRITE_BEAUTY",
           movement = "STAY", range = "NONE",
           text = "TEXT_TUT6_NPC", name = "TUT6_NPC" },
       } },
     })
   end
   ```

   `movement` is `"STAY"` or `"WALK"`; `range` bounds a walker
   (`"ANY_DIR"`, `"UP_DOWN"`, `"LEFT_RIGHT"`, or a fixed facing:
   `"DOWN"`, `"UP"`, `"LEFT"`, `"RIGHT"`, `"NONE"`). Pick an `index`
   far above the map's own (vanilla counts are single digits) — it keys
   the NPC's identity in saves and pools. Outcome: a new NPC stands in
   Pallet Town.

2. **Give it a talk script.** The `map_scripts` registry is **compose**:
   your contribution merges beside the map's own scripts instead of
   replacing them, keyed per TEXT constant:

   <!-- snippet: run -->
   ```lua
   mod.content.map_scripts:register("PALLET_TOWN", {
     talk = {
       TEXT_TUT6_NPC = {
         { "face_player" },
         { "ask", "Want to hear a\nsecret?" },
         { "jump_if_false", "no" },
         { "show_text", "The sign in this\ntown is MODDED." },
         { "jump", "end" },
         { "label", "no" },
         { "show_text", "Suit yourself." },
       },
     },
   })
   ```

   Outcome: talking to the NPC runs the rows — a YES/NO box with two
   different replies. Note the `label` rows: jumps target labels, so
   inserting a row never breaks a branch (some legacy vanilla scripts use
   absolute row numbers; do not copy that).

3. **Or spawn dynamically.** For scripted or conditional actors, spawn at
   runtime instead of patching the map — same object shape, not
   serialized, so re-spawn on entry:

   <!-- snippet: run -->
   ```lua
   mod.events:on("map.entered", function(ev)
     if ev.mapId == "PALLET_TOWN" then
       mod.world:spawnNpc("PALLET_TOWN", {
         index = 91, x = 10, y = 9, sprite = "SPRITE_FISHER",
         movement = "STAY", range = "NONE", text = "TEXT_TUT6_NPC",
       })
     end
   end)
   ```

   Outcome: the second NPC appears on every visit and shares the talk
   script.

## Checkpoint

Both YES and NO branches reach their text. Two mods registering talk
entries on `PALLET_TOWN` both land — compose semantics — and Oak's own
script is untouched. Disable the mod: Pallet Town is vanilla.

## Common pitfalls

- **Absolute-numeric jumps.** `{ "jump", 6 }` breaks the moment a row is
  inserted; label targets are the default. (`"end"` is the reserved
  end-of-script target.)
- **Reusing a vanilla object `index`.** Saves key defeated/taken state by
  `<mapId>_obj_<index>`; a collision inherits some other object's state.
  That string is the object's identity everywhere, not just in the save:
  [Map objects and object ids](Concepts-Data-Model#map-objects-and-object-ids).
- **Expecting talk entries to chain.** Per TEXT constant, the
  highest-precedence contribution *wins* (priority, then load order) —
  talk entries merge per key, they do not run one after another. The
  `onEnter`/`onStep` handlers are the chaining kind.

Next: [Tutorial 07 — New Map](Tutorial-07-New-Map).
