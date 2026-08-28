# The mod object

Every member of the `mod` table the loader hands your entry function, as
constructed in `src/mods/Loader.lua` (`_api`). Nothing outside this
surface, the registries, the cataloged events/hooks, and the documented
data schemas is supported.

Your chunks run inside a per-mod sandbox (`src/mods/Sandbox.lua`): `_G` is
your own table, `io` / `os` / `love.filesystem` / `love.system` /
`love.event` answer through compat stand-ins (`src/mods/LegacyCompat.lua`)
that log a migration warning per call, and `love.thread`, `ffi` and
`debug` are refused outright. The members below are the sanctioned
replacements.

## Identity

| Member | Value |
|---|---|
| `mod.id` | the manifest id |
| `mod.version` | the manifest version string |
| `mod.path` | the mod's directory ("mods/<id>") |
| `mod.manifest` | a deep copy of the validated manifest — mutating it changes nothing |
| `mod.DELETE` | the tombstone sentinel for `patch` (`patch(id, { field = mod.DELETE })`) |

## Content

| Member | Signature | Notes |
|---|---|---|
| `mod.content.<registry>:register` | `(id, value)` | add; duplicate id errors |
| `mod.content.<registry>:override` | `(id, value)` | replace whole record |
| `mod.content.<registry>:patch` | `(id, partial)` | deep-merge |
| `mod.content.<registry>:remove` | `(id)` | tombstone |
| `mod.content.<registry>:get` | `(id) -> value` | merged view, base data included |
| `mod.content.<registry>:each` | `() -> iterator` | merged view |

All 37 registries plus the v1 aliases (`scripts`, `ui`) hang off
`mod.content`; see [Reference: Registries](Reference-Registries). Content
verbs are entry-chunk-only ([Lifecycle](Concepts-Lifecycle)).

## Events and hooks

| Member | Signature |
|---|---|
| `mod.events:on` | `(name, callback, priority) -> unsubscribe` |
| `mod.events:once` | `(name, callback, priority) -> unsubscribe` |
| `mod.events:emit` | `(name, payload)` — only `"mod.<id>.*"` names |
| `mod.hooks:wrap` | `(name, callback, priority) -> unsubscribe` |

Catalogs: [Reference: Events](Reference-Events),
[Reference: Hooks](Reference-Hooks).

## Persistence

| Member | Signature | Backed by |
|---|---|---|
| `mod.save:get` | `(key, default) -> value` | `save.modData[modId]` |
| `mod.save:set` | `(key, value)` | `save.modData[modId]` |
| `mod.options:define` | `(rows)` | rows render in the manager |
| `mod.options:get` | `(key) -> value` | `options.modOptions[modId]`, falling back to the row default |
| `mod.migrations:add` | `(since, fn)` | runs on load for saves older than `since` |

Row shapes and migration ordering: [Save Model](Concepts-Save-Model).

## Durable storage and checkpoints

Independent of `mod.save` (which rides the normal SAVE), `mod.storage`
writes per-mod, per-playthrough records through the engine's persistence
backend, and `mod.checkpoints` captures/restores engine-owned runtime
state. Implementations: `src/mods/Storage.lua`, `src/core/Checkpoint.lua`.

| Member | Signature | Notes |
|---|---|---|
| `mod.storage:context` | `(game) -> { engineVersion, gameVersion, playthroughId }` | identity is opaque; no slot or path ever crosses |
| `mod.storage:write` | `(game, key, value) -> ok, code, message` | data-only tables; staged and decode-verified |
| `mod.storage:read` | `(game, key) -> value, code, message` | recovers from a valid staged/backup generation |
| `mod.storage:writeBytes` | `(game, key, bytes) -> ok, code, message` | opaque byte strings (NULs included), 512 MiB per key, staged and byte-verified; never decoded or executed |
| `mod.storage:readBytes` | `(game, key) -> bytes, code, message` | the byte counterpart of `read` |
| `mod.storage:list` | `(game, prefix) -> keys, code, message` | keys are slash-separated `[A-Za-z0-9_-]` segments |
| `mod.storage:delete` | `(game, key) -> deleted, code, message` | table and byte values share one key space; delete before switching a key's type |
| `mod.storage:selected` | `(game) -> facade \| nil, code, message` | title screen only: a bound facade over the launcher-selected playthrough, same methods minus the `game` argument; non-allocating |
| `mod.checkpoints:inspect` | `(game) -> capability` | `capability.canCapture` before capturing |
| `mod.checkpoints:capture` | `(game) -> checkpoint, code, message` | data-only; store it through `mod.storage` |
| `mod.checkpoints:restore` | `(game, checkpoint) -> ok, code, message` | validates before mutation, verifies by recapture, rolls back on failure; emits `checkpoint.restored` on success |
| `mod.checkpoints:resume` | `(game, checkpoint) -> ok, code, message` | title-session counterpart of `restore`; rebuilds a usable title session on failure |
| `mod.checkpoints:ensureNormalSave` | `(game, checkpoint) -> anchored, code, message` | make a never-saved playthrough title-bootable exactly once; `true, "already_exists"` after that |

The playthrough identity is allocated lazily on the first
storage/checkpoint call, so an unused API changes no save bytes. A
checkpoint's `identity.engineVersion` is compatibility metadata, not
runtime state: a checkpoint captured by an older engine release restores
on a newer one (`src/core/Checkpoint.lua`,
`normalizeVerificationMetadata`). Full contracts and error codes: the
Durable tool storage section of `docs/modding.md` and RFCs 0003-0006.

## Assets and files

| Member | Signature | Notes |
|---|---|---|
| `mod.assets:path` | `(relative) -> "mods/<id>/<relative>"` | the path helper every sprite field wants |
| `mod.assets:image` | `(relative) -> Image` | cached `love.graphics.newImage`; needs a graphics context |
| `mod.assets.<registry>` | — | v1 alias of `mod.content.<registry>` |
| `mod:read` | `(relative) -> contents, err` | read a file from the mod directory |
| `mod:list` | `(relative) -> names` | sorted directory listing inside the mod directory |
| `mod:info` | `(relative) -> { type, size } \| nil` | `type` is `"file"` or `"directory"`; `nil` when absent |

All path arguments join to your own directory: `..`, absolute paths and
drive letters are refused (`src/mods/SafePath.lua`). Validated
`required_imports` land under `baseroms/` and are read the same way
([Manifest](Reference-Manifest#required-user-supplied-files)).

## Scripting sugar

| Member | Signature | Notes |
|---|---|---|
| `mod.commands:register` | `(verb, fn)` | sugar over `mod.content.commands`; replacing an engine verb must say `override` on the registry |

## UI toolkit

`mod.ui` is the shared widget facade (`src/ui/ModUI.lua`); widgets load on
first touch.

| Member | What it is |
|---|---|
| `mod.ui.Menu`, `mod.ui.ListMenu`, `mod.ui.ChoiceBox`, `mod.ui.QuantityBox`, `mod.ui.NamingScreen`, `mod.ui.PicBox`, `mod.ui.TextBox`, `mod.ui.Font`, `mod.ui.Theme` | the stable widget set for building screens |
| `mod.ui.push(game, screenId, ...)` | instantiate through the `screens` registry and push |
| `mod.ui.insertBefore(items, anchorLabel, item)` | anchored menu insertion (missing anchor appends) |
| `mod.ui.insertAfter(items, anchorLabel, item)` | same, after the anchor |
| `mod.ui.removeLabel(items, label)` | remove a row by label |
| `mod.ui.PokemonIcon.draw(game, summary, x, y, opts)` | draw a party icon from the detached `{ species, hp, maxHp }` summary; `opts.selected` / `opts.counter` request the native selected animation. Composes with `icons` content and the `pokemon.icon` hook; invalid summaries return `false, code, message` |
| `mod.ui.insertStepBefore(steps, anchorId, step)` | Oak-speech step insertion ([`intro.oak_speech.build`](Reference-Hooks)) |
| `mod.ui.insertStepAfter(steps, anchorId, step)` | same, after the anchor id |
| `mod.ui.removeStep(steps, id)` | drop a step by id |

## World facade

`mod.world` materializes on first touch, once the live `Game` exists
(after `game.ready`); `nil` before that and in headless runs without a
game. Implementation: `src/world/WorldAPI.lua`.

| Member | Signature | Notes |
|---|---|---|
| `mod.world:current` | `() -> { mapId, x, y, facing }` | the player's position |
| `mod.world:warpTo` | `(mapId, x, y, facing, opts)` | scripted warp; `opts.arrive = "fly" \| "teleport"` picks the arrival FX |
| `mod.world:toggleObject` | `(mapId, objName, visible)` | persisted; emits `world.object_toggled` |
| `mod.world:setFlag` / `getFlag` | `(name, value)` / `(name) -> bool` | the shared story-flag namespace |
| `mod.world:replaceBlock` | `(bx, by, block)` | current map, block grid |
| `mod.world:spawnNpc` | `(mapId, objDef) -> npcId` | runtime NPC, same shape as `maps[].objects`; returns the object id, allocated at spawn time; not serialized — respawn on `map.entered` |
| `mod.world:removeNpc` | `(npcId)` | the id `spawnNpc` returned; refuses a mapped object and another mod's |
| `mod.world:npc` | `(mapId, indexOrName) -> handle` | active map only; accepts `def.index`, `def.name` or the object id. `handle.id` is the [object id](Concepts-Data-Model#map-objects-and-object-ids); `handle:scriptMove(dir, tiles, onDone)`, `marchInPlace`, `face`, `position` |
| `mod.world:queueScript` | `(rows, extra)` | run command rows through the script queue |
| `mod.world:invalidateMap` | `(mapId)` | drop the built map so edits show |
| `mod.world:startWildBattle` | `(species, level) -> true \| nil, reason` | push a wild battle; refuses mid-warp, mid-battle, and an unhealthy party |
| `mod.world:mapOverview` | `() -> overview` | read-only snapshot: collision `rows` (cell grid), optional `tileRows` (2x) and `tileDetailRows` (4x) of GB shades `"0"`-`"3"` with matching width/height fields, and `markers` of `{ kind, x, y }` for `warp` / visible `item` / untaken `hidden` (`src/world/MapOverview.lua`); same contract on Gold |
| `mod.world:canReorderParty` | `() -> bool` | true only during idle overworld play with 2+ mons |
| `mod.world:reorderParty` | `(fromSlot, toSlot) -> true \| nil, reason` | one-based slots; menus, movement, scripts, battles and transitions refuse |
| `mod.world:availableFieldActions` | `() -> { { id, label, rods? }, ... }` | the field items and moves that can start right now (`bicycle`, `fish`, `cut`, `surf`, `strength`, `flash`, `dig`, `teleport`; Gold adds `headbutt`, `whirlpool`, `waterfall`, `sweet_scent`, `squirtbottle`); empty while the world is busy. Render what you understand and ignore unknown ids |
| `mod.world:useFieldAction` | `(id, opts) -> true \| nil, reason` | perform a listed action through the game's own field-item path; fishing takes `opts.rod` and auto-picks a sole rod. Stale or busy requests change nothing |

## Scripted input

Source-safe GB button presses through the engine's multi-source input
bookkeeping: releasing a mod's hold can never drop a button the keyboard,
a pad, the touch overlay or another mod still owns.

| Member | Signature | Notes |
|---|---|---|
| `mod.input:tap` | `(game, btn)` | queue exactly one `wasPressed` edge for the next fixed step; holds nothing |
| `mod.input:press` | `(game, btn) -> token` | hold until released |
| `mod.input:release` | `(token) -> bool` | idempotent; refuses tokens taken by another mod. Outstanding tokens release on rollback, hot reload and input recovery |

Buttons are `up`, `down`, `left`, `right`, `a`, `b`, `start`, `select`.
Needs the live game (`game.ready`).

## Device and platform

| Member | Signature | Notes |
|---|---|---|
| `mod.device:powerInfo` | `() -> state, percent` | read-only battery state; `state` is LÖVE's `"unknown"` / `"battery"` / `"nobattery"` / `"charging"` / `"charged"`, `percent` is `0`-`100` or `nil`. The rest of `love.system` stays sandboxed |
| `mod.datetime:date` / `time` / `dateTime` | `(game, timestamp) -> string` | format a timestamp under the player's DATE FORMAT / TIME FORMAT options; invalid timestamps return `"----"` |
| `mod.steps:available` | `() -> bool` | `false` on builds without the native step bridge and for mods without the `steps` permission, so a probe is always safe |
| `mod.steps:sync` | `() -> bool` | ask iOS/Android to refresh its step count (async; OS consent sheet on first use) |
| `mod.steps:poll` | `() -> { steps, from, to } \| nil` | the next delivery for this mod; each permissioned mod gets its own copy, and the same walk is never delivered twice |

`sync` and `poll` without the `steps` permission raise an error naming it
(`src/mods/Steps.lua`).

## Background work

Both facades exist because `love.thread` is refused: the workers run
engine code, so a mod gets asynchrony without a Lua state the sandbox
cannot reach. `poll` never blocks; call it from a hook or update.

| Member | Signature | Notes |
|---|---|---|
| `mod.fetch:available` | `() -> bool` | `false` without a transport or the `network` permission |
| `mod.fetch:get` | `(url, opts) -> handle \| nil, reason` | http/https only, on the URL and every redirect; `opts.accept`, `opts.maxSeconds` (max 30); four in flight per mod |
| `mod.fetch:poll` | `(handle) -> { status, body, err, progress }` | `status`: `"pending"`, `"ok"`, `"error"`, `"cancelled"` |
| `mod.fetch:release` / `cancel` | `(handle)` | free a finished job / drop an unwanted result |
| `mod.job:available` | `() -> bool` | `false` without threads or the `background` permission |
| `mod.job:run` | `(script, arg, opts) -> handle \| nil, reason` | `script` is a file in your mod dir, run in your sandbox with no `mod` object and no `require`; plain data in, plain data out; `opts.maxSeconds` (default 5, max 30); two per mod, four per machine |
| `mod.job:poll` | `(handle) -> { status, result, err }` | same statuses as fetch |
| `mod.job:release` / `cancel` | `(handle)` | `cancel` drops the result; it cannot stop the thread, so write jobs that terminate |

The full rules (User-Agent attribution, handle ownership, budget
semantics) are in the Background HTTP and Background jobs sections of
`docs/modding.md`.

## Inter-mod API

| Member | Signature | Notes |
|---|---|---|
| `mod.exports` | a table you fill (or assign) | what other mods see |
| `mod.find` | `(otherId) -> { id, version, exports } \| nil` | `nil` when absent, disabled, failed, or not yet loaded |

## Logging

| Member | Signature |
|---|---|
| `mod.log:info` / `warn` / `error` | `(fmt, ...)` — attributed `[mod-id]` lines |

## Supported requires

Mod code may `require` exactly three engine modules without the
`engine_internals` permission: `src.mods.Semver` (range-check another
mod's exports), `src.audio.ChipAsm` (author chip music and sfx), and
`src.pokemon.Stats` (`Stats.isShiny` / `Stats.calc` for indicator mods).
Everything else under `src.` is unsupported-and-may-break; under
`POKEPORT_DEV=1` an undeclared require logs a warning naming the mod and
module.
