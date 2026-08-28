"use strict";
/* ============================================================================
   Oak's Lab wizards — the guided flows for adding an NPC, a species or a map.

   These exist because the order the engine stores things in is not the order
   a person thinks in. Nobody decides a Pokemon's catch rate before they have
   named it, and nobody wants to meet a node graph before they know who is
   talking. Each wizard asks the obvious questions first, derives the ids
   nobody should have to invent, and only then hands over to the real editor.
   ========================================================================== */

/**
 * A stepped dialog.
 *
 * `steps` is an array of { title, hint, render(body, state, refresh), check(state) }.
 * `check` returns a string to block Next with, or nothing to allow it.
 */
function runWizard({ title, state, steps, finishLabel = "Create it", onFinish }) {
  let at = 0;
  const body = el("div", {});

  const draw = () => {
    const step = steps[at];
    body.textContent = "";

    body.append(el("div", { class: "wizsteps" },
      ...steps.map((s, i) => el("span", { class: "wizstep" + (i === at ? " on" : i < at ? " done" : "") },
        (i < at ? "✔ " : "") + (i + 1) + ". " + s.title))));

    body.append(el("h2", { style: "margin-top:14px" }, step.title));
    if (step.hint) body.append(el("p", { class: "hint" }, step.hint));

    const pane = el("div", {});
    step.render(pane, state, draw);
    body.append(pane);

    const problem = step.check?.(state);
    if (problem) body.append(el("p", { class: "hint warn", id: "wizWhy" }, problem));

    const last = at === steps.length - 1;
    body.append(el("div", { class: "row", style: "margin-top:16px" },
      at > 0 ? el("button", { class: "fixed", onclick: () => { at--; draw(); } }, "‹ Back") : null,
      el("span", { class: "sp" }),
      el("button", { class: "fixed", onclick: closeDialog }, "Cancel"),
      el("button", {
        class: "primary fixed", disabled: !!problem,
        onclick: () => {
          if (step.check?.(state)) return;
          if (!last) { at++; draw(); return; }
          closeDialog();
          onFinish(state);
        },
      }, last ? finishLabel : "Next ›")));
  };

  draw();
  dialog(title, body);
}

// Every wizard opens the same way: type a name, watch the id appear. The id is
// editable, but nobody has to think about it to get moving.
function nameStep({ title, hint, label, placeholder, derive }) {
  return {
    title,
    hint,
    render(pane, s, refresh) {
      pane.append(el("label", {}, label));
      pane.append(el("input", {
        value: s.name, placeholder, autofocus: true,
        oninput: (e) => {
          s.name = e.target.value;
          if (!s.idEdited) s.id = idFromName(s.name);
          refreshIdLine();
        },
      }));

      const idLine = el("div", { class: "hint" });
      pane.append(idLine);

      const adv = el("details", { style: "margin-top:8px" },
        el("summary", { style: "cursor:pointer;color:var(--dim);font-size:11px" }, "Change the id myself"));
      adv.append(el("input", {
        value: s.id,
        oninput: (e) => { s.id = idFromName(e.target.value); s.idEdited = true; refreshIdLine(); },
      }));
      pane.append(adv);

      function refreshIdLine() {
        idLine.textContent = s.name ? derive(s) : "";
        const why = pane.parentElement?.querySelector("#wizWhy");
        if (why) why.remove();
        refreshButtons();
      }
      // Re-run the step's check without redrawing the whole pane, so typing
      // does not steal focus from the box being typed into.
      function refreshButtons() {
        const btn = pane.parentElement?.querySelector("button.primary");
        if (btn) btn.disabled = !s.name.trim();
      }
      refreshIdLine();
    },
    check: (s) => (s.name.trim() ? null : "Give it a name first."),
  };
}

/* ------------------------------------------------------------------- NPC -- */

// Adding a person used to be a wizard like the two below. It is now the
// Content tab's NPC workspace instead -- same questions, same order, but they
// stay on screen so any of them can be changed later without a second flow.
// Only this helper survived, because both the workspace and the map wizard
// need somewhere to append to.

// One patch record per vanilla map, however many things get added to it.
function ensureMapPatch(mapId) {
  const found = P.maps.find((m) => m.verb === "patch" && m.id === mapId);
  if (found) return found;
  const made = mapFromVanilla(mapId);
  if (made) P.maps.push(made);
  return made;
}

// Adding a species used to be a wizard here too. It is now the Content tab's
// Pokemon workspace instead, the same graduation the NPC one already made
// (see the comment above) -- see the "Add a new Pokemon" recipe in ui.js.

/* ------------------------------------------------------------------ maps -- */

function mapWizard() {
  runWizard({
    title: "Add a new place",
    state: {
      name: "", id: "", idEdited: false,
      tileset: GAME ? Object.keys(GAME.tilesets)[0] : "CAVERN",
      w: 6, h: 6,
      connect: true, fromMap: "PALLET_TOWN", marker: { x: -1, y: -1 },
    },
    steps: [
      nameStep({
        title: "What is this place called?",
        hint: "The name shown on the town map and in your own code.",
        label: "Name the area",
        placeholder: "e.g. Hidden Cave",
        derive: (s) => `The engine will know it as ${s.id}.`,
      }),
      {
        title: "What does it look like?",
        hint: "The tileset decides which blocks you can paint with. You can change it later.",
        render(pane, s) {
          pane.append(el("label", {}, "Tileset"));
          pane.append(refSelect("tilesets", () => s.tileset, (v) => { s.tileset = v; }, { blank: "— pick a tileset —" }));
          pane.append(el("div", { class: "grid2" },
            el("div", {}, el("label", {}, "Width (blocks)"),
              el("input", { type: "number", min: 1, max: 60, value: s.w, oninput: (e) => { s.w = +e.target.value; } })),
            el("div", {}, el("label", {}, "Height (blocks)"),
              el("input", { type: "number", min: 1, max: 60, value: s.h, oninput: (e) => { s.h = +e.target.value; } }))));
          pane.append(el("p", { class: "hint" }, "One block is four tiles square. Six by six is about one screen."));
        },
        check: (s) => (s.tileset ? null : "Pick a tileset."),
      },
      {
        title: "How do you get in?",
        hint: "A place with no way in is a place nobody sees. Pick the map the door goes on and tap the spot.",
        render(pane, s, refresh) {
          pane.append(el("label", {},
            el("input", { type: "checkbox", checked: s.connect, onchange: (e) => { s.connect = e.target.checked; refresh(); } }),
            "Add a way in now"));
          if (!s.connect) {
            pane.append(el("p", { class: "hint warn" },
              "Without a door the player can never reach this place. You can add one from the Maps screen under Content later."));
            return;
          }

          pane.append(el("label", {}, "Enter it from"));
          pane.append(refSelect("maps", () => s.fromMap, (v) => {
            s.fromMap = v; s.marker.x = -1; s.marker.y = -1; refresh();
          }, { blank: "— pick a map —" }));

          if (!s.fromMap) return;
          pane.append(el("div", { style: "margin:8px 0;overflow:auto" }, miniMap(s.fromMap, s.marker, () => refresh())));
          pane.append(el("p", { class: "hint" },
            s.marker.x < 0 ? "Tap where the entrance should be." : `Entrance at cell ${s.marker.x}, ${s.marker.y}.`));
          const isOwn = P.maps.some((x) => x.id === s.fromMap) || P.mapDrafts.some((x) => x.id === s.fromMap);
          if (!isOwn) {
            pane.append(el("p", { class: "hint warn" },
              `Careful: ${s.fromMap} is one of the game's own maps and you are about to change it. `
              + "The door is appended, so nothing vanilla is lost and disabling your mod puts it back — "
              + "but another mod that rewrites the same map could clash with yours."));
          }
        },
        check: (s) => (!s.connect ? null
          : !s.fromMap ? "Pick the map the door goes on."
          : s.marker.x < 0 ? "Tap the map to place the entrance." : null),
      },
    ],
    onFinish(s) {
      const map = newMapRecord(s.id, s.tileset, s.w, s.h);
      map.rec.label = s.name;

      // The door back to s.fromMap is real content on THAT map too, so it is
      // not written anywhere yet -- just noted on the draft -- until it is
      // actually resolved. See resolvePendingConnect() in map.js.
      if (s.connect && s.fromMap) {
        map._pendingConnect = { fromMap: s.fromMap, marker: { x: s.marker.x, y: s.marker.y } };
      }

      P.mapDrafts.push(map);
      P.sel.map = map.uid;
      P.sel.mapEnt = null;
      touch();
      renderAll();
      contentSub = "maps";
      showTab("content");
      toast(`${s.name} is ready — press “Add to the mod” to keep it`);
    },
  });
}

/* -------------------------------------------------------------- deleting -- */

// Deleting a place should also offer to take back the hole it punched in a
// vanilla map, otherwise the mod ships a door to nowhere.
function deleteMap(m) {
  if (!confirm(`Delete ${m.rec.label || m.id}?`)) return;

  if (m.entryFrom) {
    const host = P.maps.find((x) => x.verb === "patch" && x.id === m.entryFrom.mapId);
    if (host) {
      const i = host.rec.warps.findIndex((w) =>
        w.x === m.entryFrom.x && w.y === m.entryFrom.y && w.destMap === m.id);
      if (i >= 0 && confirm(`Also remove the door you added to ${m.entryFrom.mapId}?`)) {
        host.rec.warps.splice(i, 1);
        if (isPatchEmpty(host)) P.maps = P.maps.filter((x) => x.uid !== host.uid);
      }
    }
  }

  P.maps = P.maps.filter((x) => x.uid !== m.uid);
  if (P.sel.map === m.uid) { P.sel.map = null; P.sel.mapEnt = null; }
  touch();
  renderAll();
}

function isPatchEmpty(m) {
  if (m.verb !== "patch" || m.dirtyBlocks) return false;
  const c = m.rec._vanillaCounts || { warps: 0, signs: 0, objects: 0 };
  return ["warps", "signs", "objects"].every((k) => (m.rec[k] || []).length <= c[k]);
}

function deleteEntry(e) {
  if (!confirm(`Delete ${e.registry} "${e.id}"?`)) return;
  P.entries = P.entries.filter((x) => x.uid !== e.uid);
  if (P.sel.entry === e.uid) P.sel.entry = null;
  touch();
  renderAll();
}
