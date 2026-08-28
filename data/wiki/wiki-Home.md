# Pokemon Gen 1 Recomp Wiki

A native LÖVE2D (Lua) recreation of Pokemon Red with a first-class mod
platform built in. The engine and map behavior are hand-written Lua; game
data and graphics are decoded on first boot from a ROM the player supplies.
No ROM bytes ship with the game, and none may ship with a mod.

This wiki **is** the place to go to learn all about the modding engine: 
concepts, a twelve-rung tutorial ladder, a task-sized cookbook, and reference 
pages written against the real engine source. Player-facing pages 
(link play, the save editor, developer setup) live here too. 
The repository keeps only a pointer at `docs/modding.md`.

## What a mod can do

Every noun in the game — species, moves, items, maps, tilesets, encounters,
trainers, statuses, balls, evolution methods, growth curves, types, screens,
songs, cries, palettes, font glyphs, script commands, text tokens,
transitions — is a **record** in one of 37 **registries** a mod can
`register`, `override`, `patch`, or `remove`. Engine decisions — damage,
accuracy, catch rate, turn order, encounters, music selection, menu
assembly — pass through named **hooks** a mod can wrap, and state changes
announce themselves through **events**. A mod is a directory with a
`manifest.json` and a `main.lua`; disabling it restores vanilla exactly.

<!-- snippet: run -->
```lua
-- mods/faster_growlithe/main.lua : a complete mod
return function(mod)
  mod.content.pokemon:patch("GROWLITHE", { baseStats = { speed = 90 } })
end
```

## Find your entry point

| You are | Start with | Then |
|---|---|---|
| A player who wants Charizard to learn Fly or grass encounters halved | [Getting Started](Getting-Started) | [Tutorial 01](Tutorial-01-Sprite-And-Text-Tweak), [Tutorial 02](Tutorial-02-Balance-Patch) |
| A pixel artist replacing sprites, tilesets, palettes, or fonts | [Art Pipeline](Guide-Art-Pipeline) | [Tutorial 03](Tutorial-03-New-Species) |
| A musician writing songs and cries | [Audio Authoring](Guide-Audio-Authoring) | [Tutorial 09](Tutorial-09-Custom-Music) |
| A quest author adding NPCs, dialogue, and story beats | [Concepts: Registries](Concepts-Registries) | [Tutorials 06–08](Tutorial-06-NPC-And-Dialogue) |
| A mechanic designer changing how the game works | [Concepts: Events and Hooks](Concepts-Events-And-Hooks) | [Tutorial 10](Tutorial-10-New-Mechanic) |
| A team building a total conversion | [Total Conversions](Guide-Total-Conversions) | [Tutorial 12](Tutorial-12-Mini-Total-Conversion) |
| A tool builder making editors, linters, or CI for mods | [Modkit CLI](Guide-Modkit) | [Reference: Registries](Reference-Registries) |

Just installing mods, not writing them? [Getting Started](Getting-Started)
covers install and enablement; the in-game mod manager (Options menu) shows
per-mod state, errors, and options.

## The rules of the platform

- **Vanilla is sacred.** With no mods installed, behavior is identical to
  the parity oracle. Every extension point is a no-op when unused, and
  disabling a mod restores vanilla exactly.
- **Fail loud, fail local, fail soft.** Every mod callback is
  pcall-isolated and attributed to its mod. A broken mod is skipped with a
  visible error in the manager; it never crashes the game or corrupts a
  save.
- **No ROM content in mods.** A mod ships original assets or *asset
  transforms* — recipes that generate derived art on the player's machine
  from their own imported cache. The loader never imports or executes
  ROM-hack patches (IPS/BPS/UPS). See [Publishing](Guide-Publishing).
- **v1 mods work forever.** A manifest without `api` gets full
  compatibility mode; nothing a v1 mod does stops working under mod API 2.
  See [Compatibility](Concepts-Compatibility).

## How the wiki is organized

- **Concepts** — how the machine works: the boot
  [lifecycle](Concepts-Lifecycle), [registry](Concepts-Registries) merge
  semantics, the [event/hook](Concepts-Events-And-Hooks) rule, the
  [data model](Concepts-Data-Model), the [save model](Concepts-Save-Model),
  and [compatibility](Concepts-Compatibility).
- **Tutorials** — a dependency-ordered ladder from a ten-minute first mod
  to a mini total conversion. Each rung is a runnable mod with a checkpoint.
- **[Cookbook](Cookbook)** — 37 task-sized recipes for people who already
  know the ladder and need one thing.
- **Reference** — the registry catalog, the event and hook catalogs, the
  `mod` object, and the manifest, each written from the engine source it
  documents (`src/mods/Schemas.lua`, the `Runtime.emit`/`Runtime.call`
  sites, `src/mods/Loader.lua`, `src/mods/Manifest.lua`).
- **Guides** — cross-cutting workflows: art, audio, total conversions,
  link safety, packaging.

The [registry reference](Reference-Registries) is generated from
`src/mods/Schemas.lua`, so it cannot drift from the engine. Regenerate it
into a wiki checkout with:

```sh
luajit tools/gen_registry_docs.lua ../pokemon-gen1-recomp-project.wiki
```

Everything else here is hand-authored against the engine source, following
the [docs style guide](Guide-Style).
