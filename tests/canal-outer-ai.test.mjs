// canal-outer-ai.test.mjs - Canals: when Canals buys an AI civilization a Canal past ring 3 (canals-outer-ai.js), on the
// fake map of tests/fake-game.mjs. The purchase itself was watched in a lab game; these pin the decision: an owned
// site past ring 3 worth a canal, the tech, peace, and twice the price kept after paying.
import test from "node:test";
import assert from "node:assert/strict";
import { drawMap, loadCanals, addCity } from "./fake-game.mjs";

await loadCanals();
const AI = await import("/tower-canals/ui/canals-outer-ai.js");
const { state } = await import("/tower-canals/ui/canals-state.js");

// One row of land between two seas that never meet: every land tile is a cut between two large bodies of water. The
// settlement is at C; 1 and 2 are inside ring 3, 5 and 6 are 5 and 6 out.
const STRAIT = `
~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
 . 1 C 2 . . 5 6 . . . . . .
~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
`;
const PRICE = 200;
let gold = 1000;
let war = false;
let city = null;

function setup() {
  const m = drawMap(STRAIT, { age: 0 });
  addCity(1, m.all("C")[0], ["1", "2", "5", "6"].map(m.plot));
  city = { ...globalThis.Cities.get(1), id: 1, Gold: { getBuildingPurchaseCost: () => PRICE } };
  const ai = { isAlive: true, isMajor: true, isHuman: false, Treasury: { get goldBalance() { return gold; } },
    Techs: { isNodeUnlocked: (n) => tech.has(n) }, Diplomacy: { isAtWarWith: () => war },
    Cities: { getCities: () => [city] } };
  globalThis.Players = { get: (p) => (p === 1 ? ai : null) };
  globalThis.YieldTypes ??= { YIELD_GOLD: 0 };
  state.localId = 0;
  return m;
}
const tech = new Set();
const canal = () => globalThis.GameInfo.Constructibles.lookup("BUILDING_CANAL_ANTIQUITY");
const node = () => { const r = globalThis.GameInfo.ProgressionTreeNodeUnlocks.find((x) => x.TargetType === "BUILDING_CANAL_ANTIQUITY"); return r && r.ProgressionTreeNodeType; };
const pickAt = (m) => { const p = AI.pickPurchase(1, canal()); return p ? `${p.site.loc.x},${p.site.loc.y}` : null; };
const name = (m, n) => `${m.at(n).x},${m.at(n).y}`;

test("outer AI canal: an owned site past ring 3 worth a canal is picked, never one inside ring 3", () => {
  const m = setup(); gold = 1000; war = false; if (node()) tech.add(node());
  const at = pickAt(m);
  assert.ok(at === name(m, "5") || at === name(m, "6"), `picked ${at}`);
});

test("outer AI canal: without the Canal's tech, nothing", () => {
  const m = setup(); gold = 1000; war = false; tech.clear();
  if (!node()) return; // a database with no unlock row has nothing to gate
  assert.equal(pickAt(m), null);
});

test("outer AI canal: at war, nothing", () => {
  const m = setup(); gold = 1000; war = true; if (node()) tech.add(node());
  assert.equal(pickAt(m), null);
  war = false;
});

test("outer AI canal: twice the price kept after paying, or nothing", () => {
  const m = setup(); war = false; if (node()) tech.add(node());
  gold = PRICE * 3 - 1;
  assert.equal(pickAt(m), null, "599 gold leaves less than 400 after a 200 Canal");
  gold = PRICE * 3;
  assert.ok(pickAt(m), "600 leaves 400");
});
