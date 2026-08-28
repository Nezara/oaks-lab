# Tutorial 07 — New map

**Goal.** Author a new outdoor map, connect it to Pallet Town, and fill
its grass with wild encounters.

**Prerequisites.** Tutorial 06;
[Concepts: Data Model](Concepts-Data-Model).

**Files created.**

```text
mods/tutorial_07_map/
├── manifest.json
└── main.lua
```

## Steps

1. **Register the map on a vanilla tileset.** A map record is a block
   grid over a tileset. Reuse `OVERWORLD` (Pallet Town's tileset) so its
   block ids, walkability, and grass tile all come for free:

   <!-- snippet: run -->
   ```lua
   return function(mod)
     local W, H = 6, 5
     local blocks = {}
     for i = 1, W * H do blocks[i] = 10 end   -- plain ground
     blocks[8], blocks[9] = 11, 11            -- a strip of tall grass

     mod.content.maps:register("MODROUTE", {
       id = "MODROUTE", label = "ModRoute", index = 1000,
       tileset = "OVERWORLD",
       width = W, height = H, blocks = blocks,
       borderBlock = 10,
       connections = { west = { map = "PALLET_TOWN", offset = 0 } },
     })
   end
   ```

   Width and height are in blocks; `blocks` must hold exactly
   `width * height` ids (validation counts). Block ids index the
   tileset's block table — inspect a vanilla map on the same tileset to
   pick them (`mod.content.maps:get("PALLET_TOWN").blocks`,
   `mod.content.tilesets:get("OVERWORLD")` — its `grassTile` is the tile
   that rolls encounters). Give mod maps `index = 1000` and up; the
   two-digit ROM ids below are taken. Outcome: `modkit validate` passes,
   including the width×height check.

2. **Connect it both ways.** A connection is per-side data; patch the far
   map so its free edge points back:

   <!-- snippet: run -->
   ```lua
   mod.content.maps:patch("PALLET_TOWN", {
     connections = { east = { map = "MODROUTE", offset = 0 } },
   })
   ```

   `connections` is a dictionary, so the patch adds `east` beside Pallet
   Town's vanilla north/south. `offset` slides the neighbor along the
   shared edge in blocks. Outcome: walking off Pallet Town's east edge
   scrolls seamlessly into MODROUTE, and back.

3. **Add encounters.**

   <!-- snippet: illustrative -->
   ```lua
   mod.content.encounters:register("MODROUTE", {
     grass = {
       rate = 25,
       slots = {
         { species = "MODMON", level = 5 },   -- most common
         { species = "PIDGEY", level = 4 },
         { species = "RATTATA", level = 4 },
         { species = "PIDGEY", level = 5 },
         { species = "RATTATA", level = 5 },
         { species = "PIDGEY", level = 3 },
         { species = "RATTATA", level = 3 },
         { species = "PIDGEY", level = 6 },
         { species = "RATTATA", level = 6 },
         { species = "MODMON", level = 7 },   -- rarest
       },
     },
   })
   ```

   Ten slots, weighted front-to-back by the Gen 1 bucket table
   (`constants.encounterBuckets`) — slot 1 is roughly 1-in-4, slot 10 is
   about 1-in-100. Outcome: stepping in the grass strip rolls wild
   MODMON. (Requires tutorial 03's species, or swap in vanilla ids.)

4. **Custom tilesets, when you outgrow vanilla.** Register through
   `tilesets` — `image` (your sheet), `blocks` (each block a row of 16
   tile ids), plus `walkable`, `counterTiles`, `doorTiles`, `warpTiles`,
   `grassTile`, `animation`. The art contract is in
   [Guide: Art Pipeline](Guide-Art-Pipeline).

## Checkpoint

Walk Pallet Town → MODROUTE → Pallet Town without a seam; encounter a
wild mon in the grass; save on MODROUTE and reload — the new map id is a
known id, so the location round-trips. Disable the mod on that save and
the location falls back to the heal point with a report
([Save Model](Concepts-Save-Model)).

## Common pitfalls

- **A one-way connection.** Register `west` on the new map *and* patch
  `east` on the old one, or you can enter but never leave (or vice
  versa).
- **A wrong `offset`.** The neighbor slides sideways and the far edge
  walks into border blocks; 0 aligns both origins on the shared edge.
- **`blocks` count mismatch.** `width * height` is validated — a wrong
  count is caught at load, not at render.
- **Walking on water.** Block ids you picked may not be walkable in the
  tileset's `walkable` table; test the whole floor.

Next: [Tutorial 08 — Quest](Tutorial-08-Quest).
