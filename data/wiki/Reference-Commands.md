# Script command reference

The verbs available in script rows — map scripts, quest scripts, cutscenes.
A script is an array of rows; each row is `{ "verb", arg1, arg2, ... }`.
Implementation and per-verb porting notes: `src/script/Commands.lua`. All
of these are records in the `commands` registry, registered by the engine
under the owner `engine`, so a mod adds a verb with
`mod.commands:register(verb, fn)` and replaces one with
`mod.content.commands:override(verb, fn)`.

A handler is `fn(ctx, ...)`; returning a string jumps to that label
(`"end"` ends the script). `ctx` carries `ctx.save`, `ctx.overworld`,
`ctx.game`, `ctx.runner`, and the branch state below.

## Branch state

Check-style verbs set `ctx.lastCheck`; `jump_if_true` / `jump_if_false`
branch on it. `choice` also sets `ctx.lastChoice = { index, label }`.
Use `label` rows as jump targets — never absolute row numbers, which break
when a row is inserted.

## Text and choices

| Verb | Args | Does |
|---|---|---|
| `show_text` | `textId, subs` | show a text box; `textId` is a generated-text label (`"_PalletTownGirlText"`), a map TEXT_* pointer, or a literal. `subs` fills `{RAM:...}` tokens |
| `ask` | `textId, subs` | text, then YES/NO; result in `lastCheck` |
| `choice` | `labels, opts` | N-way menu; `lastChoice = { index, label }`, `lastCheck = (index == 1)`; `opts.default` preselects, `opts.cancel` is the B index |
| `text_opts` | `opts` | TextBox options for the next `show_text` only (`auto = true` is the no-button-wait box) |
| `text_sound` | `soundId` | arm the NEXT `show_text` with a trailing jingle (the ROM's `sound_get_item_1` / `sound_get_key_item` text-command idiom): it fires once the last page has typed and the box waits on it before the button wait |

## Flow

| Verb | Args | Does |
|---|---|---|
| `label` | `name` | jump target, pre-scanned by the runner |
| `jump` | `target` | unconditional jump to a label |
| `jump_if_true` / `jump_if_false` | `target` | branch on `lastCheck` |
| `wait` | `frames` | block for n frames |
| `wait_flag` | `flagName, timeoutFrames` | yield until the flag sets; `lastCheck` false on timeout. The sync primitive for parallel scripts |
| `run_parallel` | `rowsOrRef, opts` | start a background script (bounded slots) and continue; `rowsOrRef` is a row array or `"MAP_ID/name"` naming a `map_scripts` `scripts` entry |

## Flags, items, money

| Verb | Args | Does |
|---|---|---|
| `set_flag` / `clear_flag` | `name` | write the shared story-flag namespace |
| `check_flag` | `name` | `lastCheck` = flag state |
| `check_item` | `itemId` | `lastCheck` = bag has one |
| `give_item` | `itemId, count, gotText` | add to bag with the received jingle; `gotText = false` when the script shows its own text |
| `take_item` | `itemId, count` | remove from bag |
| `give_money` | `amount` | add money |
| `set_field` | `key, value` | scratch state outside the flag namespace; `"mod:key"` routes to the owning mod's `save.modData` |

## Battles and mons

| Verb | Args | Does |
|---|---|---|
| `start_battle` | `"wild", species, level` or `"trainer", OPP_CLASS, partyIndex` | run a battle |
| `static_battle` | `species, level, beatFlag` | a static encounter (Snorlax/birds idiom); `beatFlag` set on any non-blackout end |
| `rival_battle` | `oppClass, baseParty, offsets` | the starter-counterpick party math |
| `check_battle_result` | `"win"\|"lose"\|"run"\|"caught", ...` | `lastCheck` = result is any of the given |
| `give_pokemon` | `species, level, skipNickname` | gift mon; emits the mutable `pokemon.before_give` first; `lastCheck` false when party and boxes are full. `skipNickname = true` suppresses the nickname prompt for callers that name the gift themselves |
| `save_end_battle_text` | `textId` | stash the after-battle line the next scripted battle shows on defeat, with `{PLAYER}`/`{RIVAL}` expanded |
| `heal_party` | | full heal |
| `trade` | `tradeIndex, doneFlag` | an in-game NPC trade |
| `old_man_demo` | | the Viridian catch tutorial |
| `record_hall_of_fame` | | Hall of Fame sequence |
| `mark_seen` | `species` | set the Pokedex SEEN flag |
| `check_dex_owned` | `n` | `lastCheck` = at least `n` species owned (default 1) |
| `dex_rating` | | Oak's seen/owned tally and rating line; blocks until the box closes |

## Movement and staging

| Verb | Args | Does |
|---|---|---|
| `move_player` | `dir, tiles` | walk the player |
| `move_npc` | `objIndex, dir, tiles` | walk an NPC |
| `place_npc` | `objIndex, x, y, facing` | teleport an NPC to a cell, no walk |
| `move_npc_to` | `objIndex, tx, ty` | pathfind an NPC to a cell |
| `walk_npc` | `objIndex \| "player", dirs, opts` | chained walk along a direction list; `opts.wait = false` returns immediately |
| `march_in_place` | `objIndex, on` | toggle walk-in-place; non-blocking |
| `face` | `dir` | face the scripted NPC |
| `face_player` | | scripted NPC faces the player |
| `face_object` | `objIndex, dir` | face an arbitrary object |
| `face_npc` | | player faces the scripted NPC |
| `face_player_dir` | `dir` | force the player's facing |
| `emote` | `target, bubble, frames` | emote bubble (`"shock"`, `"question"`, `"happy"`) |
| `warp` | `mapId, x, y, facing` | scripted warp |
| `remember_outdoor` | `mapId, x, y` | set `save.lastOutdoor`, the Dig / Escape Rope / blackout return point |
| `show_object` / `hide_object` | `mapId, objName` | persistent object toggles |
| `replace_block` | `bx, by, blockId` | the Cut-tree / card-key-door idiom |
| `set_tile_anim` | `anim \| false` | override the tileset animation until the next map change |
| `pan_camera` | `dx, dy, frames` or `"reset"` | offset the camera by cells (blocking) |
| `fade` | `dir, frames` | screen fade |

## Sound and screens

| Verb | Args | Does |
|---|---|---|
| `play_sound` | `soundId` | one-shot SFX |
| `play_cry` | `species` | a cry; a following `show_text` waits for it |
| `play_music` | `songId, opts` | switch music now; `opts.keep` survives the next warp |
| `play_once` | `songId` | one-shot jingle (`Music_PkmnHealed` idiom); blocks until it finishes, then the map theme resumes |
| `play_default_music` | | resume the current map's own theme after a cutscene override, keeping the bike/surf substitution rules |
| `fade_music` | `frames` | fade the music out (default 10) |
| `stop_music` | | stop music |
| `open_mart` | `textConst` | open a mart by TEXT constant |
| `push_screen` | `screenId, args` | instantiate through the `screens` registry and block until the screen pops |

## Yellow support

Verbs ported for Pokemon Yellow's scripts; on Red and Blue they are safe
no-ops or fall back sensibly.

| Verb | Args | Does |
|---|---|---|
| `load_player_starter_name` | | put the chosen starter's species name in the engine string buffer for the next text substitution |
| `spawn_pikachu_follower` | | spawn the Pikachu follower on the current map |
| `pikachu_make_way` | | Oak's Lab Pikachu step-aside movement; a no-op without a Yellow follower |

## Registering your own verb

<!-- snippet: run -->
```lua
mod.commands:register("shake_screen", function(ctx, frames)
  -- runs like any engine verb; return a label string to jump
end)
```

A registered record may also be `{ fn = fn, foreground = true, blocking =
true }` — `foreground` verbs are illegal in parallel scripts, and a
parallel script moving an NPC takes a per-NPC lock a foreground script
preempts.
