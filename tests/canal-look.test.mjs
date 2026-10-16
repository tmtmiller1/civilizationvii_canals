// canal-look.test.mjs - Canals: what drawOverlay draws for a canal (the channel arms, the house layout, the locks, the
// quay and the boats), compared model for model with tests/canal-look.snapshot.json, which was recorded from Canals
// 1.5.3's drawing code, moved into canals-look.js unchanged, before any of it was broken up. Run with
// UPDATE_SNAPSHOT=1 to record it again after a deliberate change to the look.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { drawMap, loadCanals, setCliffs, drawn } from "./fake-game.mjs";

const canals = await loadCanals();
const { drawOverlay, clearOverlay, state } = canals;
const SNAPSHOT = new URL("./canal-look.snapshot.json", import.meta.url);

const MAPS = {
  "lone canal between two seas": [`
~ ~ ~ ~
 . = . .
~ ~ ~ ~
`, 0],
  "a neck in a strip of land": [`
. . . . .
 . ~ = ~ .
. . . . .
`, 1],
  "straight two-tile cut": [`
~ ~ ~ ~ ~
 . = . . .
. = . . .
 ~ ~ ~ ~ ~
`, 1],
  "a lake beside a two-tile cut": [`
~ ~ ~ ~ ~
 . = . . .
. = ~ . .
 ~ . . . .
~ ~ ~ ~ ~
`, 1],
  "open sea all round": [`
~ ~ ~ ~ ~
 ~ = ~ ~ ~
~ ~ . ~ ~
`, 0],
  "a Modern junction": [`
~ ~ ~ ~ ~ ~
 . = . . . .
. . = = . .
 . = . . . .
~ ~ ~ ~ ~ ~
`, 2],
  "a run's end on a shore": [`
~ ~ ~ ~ ~ ~
 . = = ~ ~ ~
. . . . . .
`, 1],
  "a river and a sea on one shore": [`
. . r r r .
 . . = ~ ~ .
. . . ~ ~ .
`, 1],
};
const AGES = ["AGE_ANTIQUITY", "AGE_EXPLORATION", "AGE_MODERN", "ONE_TILE"];
const VARIANTS = [
  { landMesh: false, opened: false, cliffs: [] },
  { landMesh: true, opened: false, cliffs: [] },
  { landMesh: true, opened: true, cliffs: [0, 3] },
  { landMesh: false, opened: true, cliffs: [1, 2, 4] },
];

/** Every canal of every map, drawn in each age and each variant, each on a freshly laid map. */
function drawAll() {
  const out = {};
  for (const [name, [picture, age]] of Object.entries(MAPS)) {
    const count = drawMap(picture, { age }).all("=").length;
    for (const look of AGES) for (const [v, variant] of VARIANTS.entries()) for (let k = 0; k < count; k++) {
      const m = drawMap(picture, { age });
      for (const c of m.all("=")) setCliffs(c, variant.cliffs);
      const t = m.all("=")[k];
      const p = globalThis.GameplayMap.getIndexFromLocation(t);
      if (variant.landMesh) state.landMesh.add(p);
      if (variant.opened) state.openedHere.add(p);
      const ok = drawOverlay(t, look, variant.cliffs);
      clearOverlay(t);
      state.landMesh.delete(p); state.openedHere.delete(p);
      out[`${name} | ${look} | variant ${v} | canal ${k} at ${t.x},${t.y}`] = { ok, groups: drawn() };
    }
  }
  return out;
}

test("drawOverlay: every canal drawn as Canals 1.5.3 drew it", () => {
  const now = JSON.parse(JSON.stringify(drawAll()));
  // one line per draw, so a change to the look shows as a readable diff
  const lines = Object.entries(now).map(([k, r]) => `  ${JSON.stringify(k)}: ${JSON.stringify(r)}`);
  if (process.env.UPDATE_SNAPSHOT === "1") fs.writeFileSync(SNAPSHOT, `{\n${lines.join(",\n")}\n}\n`);
  const was = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  assert.deepEqual(Object.keys(now), Object.keys(was));
  for (const k of Object.keys(was)) assert.deepEqual(now[k], was[k], k);
  const models = Object.values(was).reduce((n, r) => n + r.groups.reduce((a, g) => a + g.models.length, 0), 0);
  assert.ok(models > 1000, `the snapshot draws something (${models} models)`);
});
