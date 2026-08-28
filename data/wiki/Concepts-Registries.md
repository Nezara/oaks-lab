# Content registries

How mods add, tweak, and remove game content. A registry is a named table
of ids (`pokemon`, `moves`, `items`, ...) reachable during a mod's entry
chunk as `mod.content.<name>`. Registrations are collected while every mod
loads, then folded into the live data once, at the merge boundary described
in [Lifecycle](Concepts-Lifecycle). The catalog itself — every registry's
merge semantics, `Data` target, and value schema — lives in one place,
`src/mods/Schemas.lua`, and the [registry reference](Reference-Registries)
is written from it, so the docs cannot drift from the engine.

## The five verbs

<!-- snippet: illustrative -->
```lua
mod.content.pokemon:register(id, value)  -- add a new record; duplicate ids error
mod.content.pokemon:override(id, value)  -- replace a whole record
mod.content.pokemon:patch(id, partial)   -- deep-merge onto the current record
mod.content.pokemon:remove(id)           -- tombstone; consumers treat it as absent
mod.content.pokemon:get(id)              -- the effective value, base data included
mod.content.pokemon:each()               -- iterate the merged view (base + mods)
```

`register` collides with the imported base data too: adding `"PIKACHU"`
errors, because changing an existing record is what `override` and `patch`
are for. `remove` followed by a later `register` resurrects the id.

## Patch, not restate

The classic v1 mistake was re-stating a whole species record to change one
stat, which silently dropped every field the author forgot. `patch` merges
only what you provide:

<!-- snippet: run -->
```lua
mod.content.pokemon:patch("MEWTWO", { catchRate = 1 })
mod.content.pokemon:patch("MEW", { baseStats = { attack = 120 } })  -- hp etc. intact
```

Patch rules, in order:

- Dictionary values merge per key, recursively.
- Array values replace wholesale in a record registry (element-wise merging
  of a learnset is ambiguous). In a **deep** registry they append instead,
  so two mods adding rows to the same list both land.
- To extend a list in a record registry, wrap it:
  `{ __append = { row } }` or `{ __prepend = { row } }`. The wrapper is
  unwrapped during the merge and never reaches `Data`; `__prepend` is also
  how a deep registry reaches the front of a list.
- `mod.DELETE` unsets a field:
  `patch("EEVEE", { evolutions = mod.DELETE })`.
- Patches stack across mods in load order.

## Merge semantics

Each registry declares one of three behaviors in `Schemas.lua`:

- **record** — id maps to a whole record; the verbs behave as above. Most
  registries are records.
- **deep** — the registry is one deep-mergeable tree (`constants`,
  `field`, `text_pointers`) whose ids are the top-level keys of the target
  table. `register` and `patch` are synonyms: both merge into the key,
  with lists appending. `override` replaces the whole key, which is the
  total-conversion verb. See [Data Model](Concepts-Data-Model).
- **compose** — registrations accumulate into per-id chains instead of
  replacing each other (`map_scripts`, `migrations`). Duplicate `register`
  calls are legal by design: two mods adding NPCs to the same map both
  land, ordered by `priority` (higher first) then load order. An
  `override` chain replaces the engine's own base contribution too, and a
  `false` entry in a `map_scripts` talk/scripts slot suppresses every
  lower-precedence entry.

## Validation

Every `register`/`override`/`patch` is checked against the registry's
schema. A violation is a load error attributed to the mod — named
registry, id, field path, expected type — instead of a nil-index crash
three systems downstream. A near-miss field name gets a suggestion
(`did you mean "baseStats"?`). After the merge, a cross-reference pass
resolves id-typed fields (a learnset move, an evolution target) against
the merged world and reports dangling references the same way.

Unknown top-level fields are allowed and preserved — extensible records
are a feature — but a key that is only a case/underscore variant of a
schema field is the classic typo and is rejected with the suggestion.

Mods with `"api": 1` in their manifest (or no `api` field) downgrade all
of this to logged warnings, so every v1 mod keeps loading exactly as
before.

If you use the schemas from your own tools, note the argument order:
`Schemas.check(spec, registryName, id, value, mode)` — the spec comes
FIRST, fetched from `Schemas.REGISTRIES[name]`. Passing the name first
silently validates nothing.

## Namespaces

A registry whose base data module never shipped a table merges into a
freshly created namespace (`Data.screens`, `Data.map_scripts`,
`Data.audio.songs` when absent) instead of being silently dropped — the
fate of the v1 `scripts` and `ui` registries.

## Vanilla content is registrations too

The engine registers its own built-ins — statuses, move effects, balls,
growth curves, evolution methods, script commands, text tokens, rulesets,
AI classes, battle transitions, the type chart — under the owner `engine`
before any mod runs (`src/mods/Builtins.lua`). Three consequences:
`each()` always yields the whole world, `register` on an existing vanilla
id collides and forces an explicit `override`, and the behavioral
namespaces (`Data.statuses`, `Data.commands`, ...) are populated on every
boot whether or not a mod is installed. Each registration hands over the
table the engine already reads, so the registry and the consumer are the
same object and nothing about vanilla behavior changes.

## Renames and deprecations

| v1 name | Now |
|---|---|
| `scripts` | `map_scripts` (compose). v1 registrations, previously dropped, now work. |
| `ui` | `screens` (record). Same: previously dropped, now merged. |
| `audio` | Kept, deprecated. Whole-key replacement of `Data.audio`; the granular `sfx` / `cries` / `map_songs` / `music` registries supersede it. |

The old names keep working as aliases of the same registry and log a
one-time deprecation warning per mod.
