// canal-placement.test.mjs - Canals: which of a settlement's tiles are offered as canal sites (eligiblePlots), and when
// the mod sells a Canal the engine keeps locked (unlockedByMod), on the fake map of tests/fake-game.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { drawMap, loadCanals, setTile, addCity, research, plotOf, openCanal } from "./fake-game.mjs";

const canals = await loadCanals();
const { eligiblePlots, unlockedByMod, replaceableCanal, state } = canals;
const sorted = (a) => a.slice().sort((x, y) => x - y);

// Exploration. The settlement is at C; every numbered tile touches the sea. 7 and 9 are past the build ring (4 and 6
// tiles out), 8 is 5 out.
const COAST = `
~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
 . 1 2 3 4 5 6 7 8 9 . .
. . . . C . . . . . . .
 . . . . . . . . . . . .
`;

function town() {
  const m = drawMap(COAST, { age: 1 });
  setTile(m.at("2"), { resource: true });
  setTile(m.at("3"), { units: [1] });
  setTile(m.at("4"), { district: "DISTRICT_URBAN", builds: ["BUILDING_LIBRARY"] });   // Antiquity: replaceable
  setTile(m.at("5"), { district: "DISTRICT_URBAN", builds: ["BUILDING_ACADEMY"] });   // of the age: kept
  setTile(m.at("6"), { district: "DISTRICT_URBAN", builds: ["BUILDING_PALACE"] });    // ageless: kept
  setTile(m.at("7"), { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM"] });
  setTile(m.at("9"), { district: "DISTRICT_RURAL" });
  addCity(1, m.all("C")[0], ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(m.plot));
  return m;
}
const named = (m, ns) => sorted(ns.map(m.plot));

test("eligiblePlots: bare and rural tiles by the water, and urban tiles holding only an earlier age's buildings", () => {
  const m = town();
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1", "4", "7", "9"]));
});

test("eligiblePlots: a unit on a tile keeps it out unless units are allowed (the site marks)", () => {
  const m = town();
  assert.deepEqual(sorted(eligiblePlots(1, true)), named(m, ["1", "3", "4", "7", "9"]));
});

test("eligiblePlots: past the build ring only a rural tile counts", () => {
  const m = town();
  const got = eligiblePlots(1);
  assert.ok(got.includes(m.plot("7")) && got.includes(m.plot("9")), "rural tiles 4 and 6 out");
  assert.ok(!got.includes(m.plot("8")), "a bare tile 5 out");
});

test("eligiblePlots: on the order's path an urban tile needs the engine's yes for a plain building", () => {
  const m = town();
  const ask = [];
  const host = { host: {}, type: 9, canStart: (cityID, type, args) => {
    ask.push(args.ConstructibleType);
    return { Plots: ["1", "7", "9"].map(m.plot) };
  } };
  state.originals = { hosts: [host, host] };
  try {
    assert.deepEqual(sorted(eligiblePlots(1, false, true)), named(m, ["1", "7", "9"]), "4 isn't in the engine's list");
    assert.ok(ask.length > 0, "the engine was asked");
  } finally { state.originals = null; }
});

test("eligiblePlots: a queued Canal's tile isn't offered again, and an unknown settlement gets nothing", () => {
  const m = town();
  const pending = [plotOf(m.at("1"))];
  globalThis.Configuration.editGame().setValue("Canals_Pending_v1", JSON.stringify(pending));
  assert.ok(!eligiblePlots(1).includes(m.plot("1")));
  assert.deepEqual(eligiblePlots(99), []);
});

// A canal dug again: an opened canal of an earlier age is a site for the age's Canal.

const CANAL_OF_AGE = ["BUILDING_CANAL_ANTIQUITY", "BUILDING_CANAL_EXPLORATION", "BUILDING_CANAL_MODERN"];
/** An opened canal on a named tile, dug in `age` (0-2) with that age's Canal unless another type is given. */
function dug(m, name, age, type = CANAL_OF_AGE[age]) {
  openCanal(m.at(name), age);
  setTile(m.at(name), { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FISHING_BOAT", type], feature: "FEATURE_CANALS_SITE" });
}

test("eligiblePlots: an opened canal of an earlier age is a site again; one of the age, a later age's or a one-tile canal isn't", () => {
  const m = drawMap(COAST, { age: 1 });
  dug(m, "4", 0);                             // Antiquity, in Exploration: dug again
  dug(m, "5", 1);                             // of the age: kept
  dug(m, "6", 0, "BUILDING_CANAL_ONE_TILE");  // no age of its own: kept
  dug(m, "7", 2);                             // a later age's (a save played on): kept
  addCity(1, m.all("C")[0], ["1", "4", "5", "6", "7"].map(m.plot));
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1", "4"]));
});

test("eligiblePlots: in Antiquity no canal is dug again; in Modern both earlier ages' canals are", () => {
  let m = drawMap(COAST, { age: 0 });
  dug(m, "4", 0);
  addCity(1, m.all("C")[0], ["1", "4"].map(m.plot));
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1"]));
  m = drawMap(COAST, { age: 2 });
  dug(m, "4", 0); dug(m, "5", 1); dug(m, "6", 2);
  addCity(1, m.all("C")[0], ["1", "4", "5", "6"].map(m.plot));
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1", "4", "5"]));
});

test("replaceableCanal: an unfinished old Canal, a ship on the tile, or the one-tile rules keep the tile out", async () => {
  const m = drawMap(COAST, { age: 1 });
  const occ = (builds) => builds.map((type) => ({ type, owner: 0, id: 1, complete: true }));
  assert.ok(replaceableCanal(occ(["IMPROVEMENT_FISHING_BOAT", "BUILDING_CANAL_ANTIQUITY"])), "an opened Antiquity canal");
  assert.equal(replaceableCanal([{ type: "BUILDING_CANAL_ANTIQUITY", owner: 0, id: 1, complete: false }]), null, "unfinished");
  assert.equal(replaceableCanal(occ(["BUILDING_CANAL_EXPLORATION"])), null, "of the age");
  assert.equal(replaceableCanal(occ(["BUILDING_CANAL_ONE_TILE"])), null, "no age of its own");
  assert.equal(replaceableCanal(occ(["IMPROVEMENT_FISHING_BOAT"])), null, "no canal");
  dug(m, "4", 0); setTile(m.at("4"), { units: [1] });
  addCity(1, m.all("C")[0], ["1", "4"].map(m.plot));
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1"]), "a ship in the canal");
  assert.deepEqual(sorted(eligiblePlots(1, true)), named(m, ["1", "4"]), "units allowed (the site marks)");
  // one-tile rules: the game's copy of the mode, read at most twice a second
  globalThis.Configuration.editGame().setValue("ModOptions_tower-canals", JSON.stringify({ mode: "one-tile" }));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(replaceableCanal(occ(["BUILDING_CANAL_ANTIQUITY"])), null, "one-tile rules");
  setTile(m.at("4"), { units: [] });
  assert.deepEqual(sorted(eligiblePlots(1)), named(m, ["1"]), "not offered under one-tile rules");
});

// unlockedByMod: the Market stands in for a Canal; the fake unlocks it with Shipbuilding.

test("unlockedByMod: a Canal refused only for want of the unlock, its tech researched", () => {
  drawMap(COAST, { age: 1 });
  const market = GameInfo.Constructibles.lookup("BUILDING_MARKET");
  const shipbuilding = GameInfo.ProgressionTreeNodes.lookup("NODE_TECH_EX_SHIPBUILDING").$index;
  const cartography = GameInfo.ProgressionTreeNodes.lookup("NODE_TECH_EX_CARTOGRAPHY").$index;
  assert.equal(unlockedByMod(0, market, { Success: false, NeededUnlock: shipbuilding }), false, "not researched");
  research("NODE_TECH_EX_SHIPBUILDING");
  assert.equal(unlockedByMod(0, market, { Success: false, NeededUnlock: shipbuilding }), true, "researched");
  assert.equal(unlockedByMod(0, market, { Success: false, NeededUnlock: cartography }), false, "another tech named");
  assert.equal(unlockedByMod(0, market, { Success: false }), true, "no reason at all (a save the mod was added to)");
  assert.equal(unlockedByMod(0, market, { Success: false, FailureReasons: ["LOC_X"] }), false, "a reason of its own");
  assert.equal(unlockedByMod(0, market, { Success: false, Locked: true, FailureReasons: ["LOC_X"] }), true, "locked");
  for (const flag of ["Success", "AlreadyExists", "InQueue", "InsufficientFunds"])
    assert.equal(unlockedByMod(0, market, { Success: false, [flag]: true }), false, flag);
  assert.equal(unlockedByMod(0, GameInfo.Constructibles.lookup("BUILDING_LIBRARY"), { Success: false }), false,
    "a building with no unlock");
  assert.equal(unlockedByMod(0, null, { Success: false }), false);
  assert.equal(unlockedByMod(0, market, null), false);
});

// A pillaged canal: the engine's repair answer names the damaged tile, and the wraps leave it as it is.

/** An Antiquity canal opened on tile 4 in `age`, a farm on rural tile 7, and a production host whose engine answers
 * every query with `answer(args)`; the host wrapped as the mod wraps Game.CityOperations. */
function damagedCanal(age, answer, rows = []) {
  const m = drawMap(COAST, { age });
  dug(m, "4", 0);
  setTile(m.at("7"), { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM"] });
  addCity(1, m.all("C")[0], ["1", "4", "7"].map(m.plot));
  const sent = [];
  const host = {
    canStart: (cityID, type, args) => answer(args, m),
    sendRequest: (cityID, type, args) => { sent.push(args); return true; },
    canStartQuery: () => rows,
  };
  canals.wrapHost(host, 7, false);
  return { m, host, sent };
}
const repair = (args, m) => ({ Success: true, RepairDamaged: true, Plots: args.X == null ? [m.plot("4")] : [] });
const ANTIQUITY = () => GameInfo.Constructibles.lookup("BUILDING_CANAL_ANTIQUITY").$index;
const at = (m, name) => ({ X: m.at(name).x, Y: m.at(name).y });

test("repair: the damaged canal's tile is offered, not the settlement's canal sites", async () => {
  // the age rules again (the one-tile test above leaves its mode in the game; it's read at most twice a second)
  globalThis.Configuration.editGame().setValue("ModOptions_tower-canals", JSON.stringify({ mode: "ages" }));
  await new Promise((r) => setTimeout(r, 600));
  state.enabled = true;
  try {
    const { m, host } = damagedCanal(0, repair);
    const anywhere = host.canStart(1, 7, { ConstructibleType: ANTIQUITY() }, false);
    assert.deepEqual(anywhere.Plots, [m.plot("4")]);
    assert.equal(anywhere.RepairDamaged, true);
    const there = host.canStart(1, 7, { ConstructibleType: ANTIQUITY(), ...at(m, "4") }, false);
    assert.equal(there.Success, true, "the water tile isn't refused as no isthmus");
    // the same engine with nothing damaged: the canal sites, as before
    const fresh = damagedCanal(0, () => ({ Success: true, Plots: [] }));
    assert.deepEqual(sorted(fresh.host.canStart(1, 7, { ConstructibleType: ANTIQUITY() }, false).Plots),
      named(fresh.m, ["1", "7"]));
  } finally { state.enabled = false; }
});

test("repair: the order goes to the engine as it is, for the Canal and for the boat on its tile", () => {
  state.enabled = true;
  try {
    const { m, host, sent } = damagedCanal(1, repair); // in Exploration the old Canal would be dug again if placed
    const pending = globalThis.Configuration.getGame().getValue("Canals_Pending_v1");
    // as the game's Repair sends them (RepairConstruct): canStart for the building anywhere, then an order per tile
    host.canStart(1, 7, { ConstructibleType: ANTIQUITY() }, false);
    const order = { ConstructibleType: ANTIQUITY(), ...at(m, "4") };
    assert.equal(host.sendRequest(1, 7, order), true);
    const BOAT = GameInfo.Constructibles.lookup("IMPROVEMENT_FISHING_BOAT").$index;
    const boatHere = host.canStart(1, 7, { ConstructibleType: BOAT }, false);
    assert.deepEqual(boatHere.Plots, [m.plot("4")], "the boat's repair isn't kept off the canal");
    const boat = { ConstructibleType: BOAT, ...at(m, "4") };
    assert.equal(host.sendRequest(1, 7, boat), true, "not refused as a building on the canal");
    assert.deepEqual(sent, [order, boat]);
    assert.equal(globalThis.Configuration.getGame().getValue("Canals_Pending_v1"), pending, "no new site remembered");
  } finally { state.enabled = false; }
});

test("repair: an earlier age's damaged Canal keeps its row in the production list", () => {
  state.enabled = true;
  globalThis.CityQueryType = { Constructible: 1 };
  try {
    const row = { index: ANTIQUITY(), result: { Success: true, RepairDamaged: true, Plots: [] } };
    const { host } = damagedCanal(1, repair, [row]);
    const listed = host.canStartQuery(1, 7, 1);
    assert.equal(listed.find((e) => e.index === ANTIQUITY()), row, "not dropped as an earlier age's Canal");
  } finally { state.enabled = false; delete globalThis.CityQueryType; }
});
