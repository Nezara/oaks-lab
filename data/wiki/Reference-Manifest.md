# Manifest reference

Every mod is a directory under `mods/` with a `manifest.json` beside its
entry file. Manifest v2 is a superset of v1: a manifest written for the
first API still validates unchanged.

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | required | `[A-Za-z0-9_-]+`, unique across installed mods |
| `name` | string | required | display name in the manager |
| `version` | string | required | your own version; semver if you want other mods to range-check it |
| `entry` | string | required | Lua file run at load time, relative to the mod dir |
| `api` | number | `1` | mod API this mod is written against; `2` is the current one |
| `priority` | number | `0` | lower loads first, after dependencies |
| `games` | array | all Gen 1 games | which games the mod runs on: `"gen1"`, `"gen2"`, a version id (`"red"`, `"blue"`, `"yellow"`, `"gold"`), or `"all"` |
| `dependencies` | array | `[]` | dependency entries ([formats below](#dependency-entry-formats)); enforced |
| `optional_dependencies` | array | `[]` | same formats; ordering and `mod.find` only |
| `dependency_sources` | object | none | `{ "dep_id": "owner/repo" }` GitHub fallbacks for entries that carry no repo hint of their own |
| `conflicts` | array | `[]` | `"id"` or `"id@<range>"`; enforced |
| `incompatible` | array | `[]` | alias for `conflicts`; merged into it at validate (same `"id"` / `"id@<range>"` syntax) |
| `category` | string | `"OTHER"` | manager grouping |
| `game_version` | string | none | semver range the engine must satisfy |
| `description` | string | `""` | manager detail text |
| `github` | string | none | `"owner/repo"` or a `github.com` URL; enables launcher auto-update and Other versions |
| `experimental` | boolean | `false` | when true, the mod stays off until the player enables it (with a confirm dialog) |
| `profile` | string | `"content"` | `content`, `overhaul` or `total_conversion` |
| `affects_link` | boolean | `true` unless `profile` is `content` | whether the mod is expected to move the link fingerprint |
| `permissions` | array | `[]` | `network`, `filesystem`, `engine_internals`, `steps`, `background` |
| `required_imports` | array | `[]` | user-supplied files the mod needs; the mod does not load while one is missing ([details below](#required-user-supplied-files)) |
| `optional_imports` | array | `[]` | user-supplied files that unlock optional functionality; same flow, never block loading |
| `options_schema` | string | none | file declaring the mod's options; must exist |
| `assets_transforms` | string | none | file declaring asset transforms; must exist |
| `force_enable_env` | string | none | environment variable name; when set to `"1"` it re-enables the mod over a saved disable (for platform-bridge mods bundled with one build's launcher) |

`api` above the number this engine provides is refused with
`requires mod API <n>; this engine provides <m>`. An unknown `profile` or
`permission` is a load error at `api = 2` and an attributed warning at
`api = 1`, where it falls back to `content` and to no permission.

## Version ranges

The same grammar serves `game_version` and the `@range` half of a dependency
or conflict entry.

| Form | Matches |
|---|---|
| `1.2.3` | exactly that version (`=1.2.3` is the same) |
| `>=1.0` | that version or later; also `>`, `<`, `<=` |
| `^1.2` | `>=1.2 <2.0`; the caret pins the leftmost non-zero component, so `^0.2` is `>=0.2 <0.3` |
| `>=1.0 <2.0` | space-separated comparators all have to hold |
| `^1.4 \|\| ^2.0` | `\|\|` separates alternatives |

Missing components default to zero (`1.2` is `1.2.0`) and a pre-release
sorts before its release (`1.0.0-beta` < `1.0.0`). A malformed range fails
manifest validation, so a typo is caught before the mod runs.

## Dependencies and conflicts

### Dependency entry formats

An entry in `dependencies` or `optional_dependencies` is any of:

1. `"mod_id"`
2. `"mod_id@^1.2.0"` (version-pinned)
3. `"mod_id#owner/repo"` or `"mod_id@^1.2.0#owner/repo"` (repository-hinted:
   the launcher can offer the dependency's GitHub releases as a download)
4. a structured object:

   ```json
   { "id": "mod_id", "range": "^1.2.0", "games": ["gen2"], "github": "owner/repo" }
   ```

The object form also accepts `version` for `range` and `repo` for `github`.
A repo hint that fails to normalize is dropped rather than failing
validation; `dependency_sources` at the manifest top level supplies the
same hint for entries that carry none (`src/mods/Manifest.lua`,
`parseSpecs`).

`games` on a dependency scopes when it is enforced. A mod declaring
`"games": ["gen1", "gen2"]` can mark a hard dependency
`"games": ["gen2"]`: booting Red ignores it entirely, booting Gold
requires it. Optional integrations that are optional everywhere stay in
`optional_dependencies`.

### Resolution

Resolution runs over the enabled mods and fails only the mods that cannot
be satisfied. A hard dependency that is missing, disabled, failed, or
outside its declared range fails the mod that declared it, and anything
depending on that mod fails in turn. `optional_dependencies` never fail a
mod: they order the load so a present target is already loaded when
`mod.find` asks for it.

A `conflicts` entry that is co-enabled fails the *declaring* mod -- it
asserted the incompatibility, so the outcome does not depend on priority.
Two mods naming each other both fail, and the manager offers to switch one
off. `incompatible` is the same list under a friendlier name: both arrays
are merged (first-wins on duplicate entries) before conflict checks run.

A dependency cycle fails exactly the mods in the cycle. Mods beside it load
normally.

## Required user-supplied files

`required_imports` and `optional_imports` keep copyrighted or otherwise
user-owned source material out of mod archives: the player supplies the
file, the launcher validates it, and the mod reads the private copy. Each
entry is an object:

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | stable identifier for the import |
| `name` | yes | display name in the launcher's import panel |
| `file` | yes | destination filename (a filename, never a path) |
| `md5` | yes | one MD5 digest, or an array of accepted digests |
| `format` | no | `"raw"` (default) or `"n64"` |
| `description` | no | dump or region guidance shown to the player |
| `size` | no | exact canonical byte length |
| `max_size` | no | per-import ceiling when an exact size is wrong |

Validated bytes land in `mods/<mod-id>/baseroms/<file>`, and the mod reads
them with its ordinary scoped `mod:read("baseroms/<file>")`: no host path
and no new filesystem permission. For `"n64"`, the launcher accepts
`.z64` / `.v64` / `.n64` byte orders, strips a recognized 512-byte copier
header, converts to canonical big-endian `.z64` order, and hashes the
result. Every import also has an engine-enforced 128 MiB ceiling.

Each selection is a private grant to that one mod; the launcher never
copies another mod's imported files just because a manifest names the same
digest. A missing `required_imports` entry blocks the mod before its entry
chunk runs; a missing `optional_imports` entry shows in the same launcher
panel but never blocks. MD5 identifies a known dump (it is what ROM
databases publish); it is not a security guarantee, and it is not the
SHA-1 the game-ROM importer uses. Mod archives must not contain anything
under `baseroms/`: `modkit pack` refuses with finding `MK307`
(`tools/modkit.py`). Implementation: `src/mods/RequiredImports.lua`.

## GitHub and experimental

`github` is optional. When set, the launcher MODS panel can check that
repo's GitHub Releases for installable `.zip` assets: **Update** installs a
newer release, **Versions** lets the player pick any published release
(including older ones) to roll forward or back. Accepts `owner/repo` or a
`https://github.com/owner/repo` URL; the loader normalizes both to
`owner/repo`. A malformed value fails validation. Absent or empty means no
auto-update UI for that mod.

`experimental` defaults to false. When true:

- a missing `options.mods[id]` entry means **disabled** (normal mods
  default to enabled)
- enabling in the launcher or in-game manager asks for confirmation
  ("this mod is marked experimental")
- the MODS panel badges the row `EXPERIMENTAL`

## Permissions

Mod code runs in a per-mod sandbox (`src/mods/Sandbox.lua`), and the
manager shows a mod's permissions before the player enables it. Some
permissions genuinely gate a facade; the rest are disclosure over the
sandbox's fixed rules.

| Permission | Covers |
|---|---|
| `network` | link play, `require("socket")`, and `mod.fetch` (background HTTP); without it those calls refuse and name the permission |
| `steps` | `mod.steps`, the native real-world step bridge on iOS/Android; without it `available()` answers `false` and `sync`/`poll` raise |
| `background` | `mod.job`, background compute on an engine-owned worker |
| `filesystem` | legacy disclosure; there is no raw filesystem grant, because `mod.storage` and the asset-transform root cover every legitimate write |
| `engine_internals` | requiring or patching modules outside the mod API |

Run with `POKEPORT_DEV=1` while developing: a mod that requires a private
engine module without declaring the matching permission logs one warning per
module, naming the mod and the module. Declare the permission or move to the
supported surface.
