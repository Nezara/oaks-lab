# Publishing a mod

The path from a working `mods/<id>/` directory to something other people
can install, and the rules that bind it.

## The checklist

1. **Manifest hygiene.** A real `version` (semver, so dependents can
   range-check you), a `description` the manager can show, an honest
   `profile`, `game_version` pinned only if you rely on something
   version-specific, `affects_link` stated when the profile default is
   wrong ([Link Compatibility](Guide-Link-Compatibility)). Set
   `github` to `owner/repo` if you want launcher Update / Versions.
   Mark unfinished work `experimental` so it stays off until the player
   confirms enable ([Manifest](Reference-Manifest)). State `games`
   honestly (`["gen1"]`, `["gen2"]`, specific games, or `["all"]`) so
   the launcher's per-game checkboxes and the Gold tab's mod list
   behave. Dependencies can carry a repository hint
   (`"dep_id@^1.0.0#owner/repo"`, or a structured object with
   `github`), which lets the launcher offer the download when the
   dependency is missing, and a `games` scope
   (`{ "id": "dep_id", "games": ["gen2"] }`) so a dependency only your
   Gold content needs never blocks a Gen 1 boot.
2. **`README.md`** — what the mod does, how to install it, and the
   regenerate instructions for any transform-derived art.
3. **`DIFFERENCES.md`** — what you change from vanilla, in the format of
   the engine's `docs/known-differences.md`. Your divergences are yours
   to document; the base game's ledger stays "None currently."
   ([Compatibility](Concepts-Compatibility)).
4. **Validate and lint clean.**

   ```sh
   python3 tools/modkit.py validate my_mod --strict
   python3 tools/modkit.py lint my_mod
   ```

5. **Pack** (hand zip / `.modpkg`) **or publish Releases from GitHub.**

   ```sh
   python3 tools/modkit.py pack my_mod -o my_mod-1.0.0.modpkg
   ```

   `pack` re-runs both gates at strict level — any finding refuses the
   package — and zips the directory. Users unpack into their `mods/`
   folder ([Getting Started](Getting-Started)).

   For GitHub-hosted updates, put the mod in its own repo, set
   `"github": "owner/repo"` on the manifest, and add the release
   workflow:

   ```sh
   python3 tools/modkit.py set-github my_mod owner/repo   # if the field is missing
   python3 tools/modkit.py add-release-workflow my_mod
   ```

   Each push to `main` (or a manual workflow run) publishes a
   `my_mod-<version>.zip` GitHub Release with files at the archive root —
   the shape **Import mod .zip**, **Update**, and **Versions** install.
   Bump `manifest.json`'s `version`, or put `[release X.Y.Z]` in the
   commit message, or pass a version on a manual run.

## The content rule

A distributed mod contains **no ROM-derived content**: no extracted
PNGs, no chip-audio banks, no ROM images, no IPS/BPS/UPS patches
(lint rules MK301–MK304). Derived art ships as an asset transform that
regenerates it from the player's own cache
([Art Pipeline](Guide-Art-Pipeline)). Because nothing you distribute
contains Nintendo/Game Freak content, your mod is shareable as ordinary
open-source Lua and PNGs — the same posture the engine itself claims.

Branding is your responsibility: name and present your mod as your own
work, not as an official product.

## User-supplied files (`required_imports`)

When your mod needs source material you cannot ship (another game's
ROM, say), declare it instead of bundling it. `required_imports` and
`optional_imports` in the manifest each list objects with a stable
`id`, a display `name`, a destination `file` (a filename, never a
path), one MD5 digest or an array of accepted digests, and optionally a
`description`, an exact `size` (or `max_size`), and a `format` (`"raw"`
default, or `"n64"`, which accepts `.z64`/`.v64`/`.n64` byte orders and
canonicalizes them).

The launcher does the rest on every platform: the mod's row shows an
import control, the player picks the file through the platform's native
picker (desktop chooser, Android SAF, iOS Files, and so on), the
launcher verifies size and digest, and the accepted bytes are copied
into `mods/<id>/baseroms/<file>`. Your code reads them with the normal
scoped API, `mod:read("baseroms/<file>")`; no host path is ever
exposed. A mod with missing `required_imports` does not load until they
are supplied; `optional_imports` never block loading.

Never ship anything under `baseroms/` in your archive: it is the
player's installation state, and `modkit lint`/`pack` refuse it
(MK307).

## Versioning etiquette

- Bump **patch** for fixes, **minor** for compatible additions,
  **major** when you break your own save shape or exported API.
- Ship a `mod.migrations:add` step whenever your `modData` shape changes
  ([Save Model](Concepts-Save-Model)) — old saves are your users'
  progress.
- Treat `mod.exports` as a public API: additive changes only within a
  major.
- Declare `conflicts` (or the alias `incompatible`) when you know two
  mods cannot coexist; the declaring mod loses at load time, so state
  it in the mod that knows.

## Play-testing the failure paths

Before shipping, test what your users will actually hit: enable alongside
popular mods (merge-order surprises), disable mid-save (your content
quarantines and reclaims cleanly), and load a save from your previous
version (migrations fire). A mod that fails politely — attributed errors,
no crashes, clean rollback — is one the manager can help users live with.
