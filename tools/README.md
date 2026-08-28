# Editing the app's own text by hand

Every heading, hint, label and warning in Oak's Lab lives as a string inside
`src/*.js`, next to the code that builds that part of the screen. For a
one-off wording fix that's fine — ask for it directly. For a pass touching
dozens of lines across several files, going through chat for each one is
slower than just editing the words yourself. `extract-copy.mjs` and
`apply-copy.mjs` are the two ends of that: pull all the text into one file,
edit it in a normal text editor, put it back.

**Run both from the project root** (`oaks-lab`, the folder this `tools/`
sits in), not from inside `tools/` itself — `tools/extract-copy.mjs` is a
path relative to wherever your terminal currently is, so running it from
`tools/` looks for `tools/tools/extract-copy.mjs` and fails with
`MODULE_NOT_FOUND`. If you're already sitting in `tools/`, drop the
`tools/` prefix instead: `node extract-copy.mjs`.

## The process

```bash
cd path/to/oaks-lab
node tools/extract-copy.mjs
```

Writes `copy.md` at the project root — one entry per piece of UI text, each
headed by an id like `### [src/move.js:1838] <p>` that says exactly where it
lives. Open it in any text editor and reword whatever you want: retitle a
step, fix a typo, rewrite a whole paragraph. Leave the `[id]` line itself
alone — that's the only thing that gets the edit back to the right spot.
Two rules the file's own header repeats:

- A `${...}` inside a line is a live value (a count, a name) computed at
  run time, not literal text — keep it word-for-word, or that entry gets
  skipped rather than guessed at.
- Keep each entry on one line. Wrapping it across several adds real line
  breaks into the string in the code, which is usually not what you want.

When you've made your changes, preview them first:

```bash
node tools/apply-copy.mjs
```

Dry run — lists every changed entry as `- old` / `+ new` and writes
nothing. Once it looks right:

```bash
node tools/apply-copy.mjs --apply
```

This writes only the lines that actually changed into the right file in
`src/`, backing up each touched file first as `<file>.js.bak` right next to
it (this project has no git yet, so that backup is the only undo — see
below). It never deletes: an entry you remove from `copy.md` entirely is
just skipped, not blanked out in the source.

After applying, rebuild as usual:

```bash
node build.mjs
```

## Things worth knowing

**`copy.md` is a worksheet, not a record.** Re-running `extract-copy.mjs`
regenerates it from whatever `src/*.js` currently says, discarding
whatever was there before. Finish one edit → apply → rebuild cycle before
starting the next; don't let two rounds of hand-edits pile up unapplied.

**Two lines always print `skipped ... -- unclosed/unterminated ...`.**
`src/script.js:718` and `src/ui.js:202` each contain a regex literal with a
stray `"` or `` ` `` inside it, which this parser (a small exact scanner,
same idea as `lua-data.mjs` — it only has to understand the one shape
`el(...)` calls take, not JavaScript in general) doesn't model. Both were
checked by hand: neither has any actual copy in it, so nothing is missing
from `copy.md` — it's just two harmless warnings on every run.

**A no-git safety net is worth setting up before a big pass.** The `.bak`
files are real but only cover the most recent apply. `git init` once at the
project root, commit, and every future round has a proper undo:

```bash
git init
git add -A
git commit -m "before hand-editing UI text"
```
