// canal-rules.test.mjs - Canals: the placement rule, the channel geometry and the AI's canal worth, run against a
// fake map (tests/fake-game.mjs) so they can be kept while ui/canals.js is split up.
//
// Maps are drawn as hex rows, odd rows indented half a hex: ~ coast, . flat, = opened canal, + queued canal, C a
// settlement centre, * ice, T Thera, r navigable river, digits name flat tiles. Ring indexes run E 0, SE 1, SW 2,
// W 3, NW 4, NE 5.
import test from "node:test";
import assert from "node:assert/strict";
import { drawMap, loadCanals, setCliffs, landAgain, plotOf } from "./fake-game.mjs";

const canals = await loadCanals();
const { isIsthmus, ruleFor, isParkland, runOf, channelSides, runArms, canalWorth, waterSideIndexes } = canals;

const ANTIQUITY = { max: 1 }, EXPLORATION = { max: 2 }, MODERN = { max: 5 };
const plots = (locs) => locs.map(plotOf).sort((a, b) => a - b);
const armsOf = (loc) => runArms(runOf(loc)).get(plotOf(loc));

// isIsthmus

test("rule: one shore is enough, in every age", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~
 . 1 . . . .
. . 2 . . .
 . . . . . .
`);
  for (const rule of [ANTIQUITY, EXPLORATION, MODERN]) {
    assert.equal(isIsthmus(m.at("1"), rule), true, "a tile on the shore");
    assert.equal(isIsthmus(m.at("2"), rule), false, "a tile one step inland");
  }
});

test("rule: flat, hill, forest and floodable land are cut; mountains, navigable rivers and wonders aren't", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~ ~
 ^ r f z h 1 .
. . . . . . .
`);
  const at = (ch) => m.all(ch)[0];
  assert.equal(isIsthmus(at("^"), EXPLORATION), false, "mountain");
  assert.equal(isIsthmus(at("r"), EXPLORATION), false, "navigable river tile");
  assert.equal(isIsthmus(at("f"), EXPLORATION), true, "forest");
  assert.equal(isIsthmus(at("z"), EXPLORATION), false, "a land natural wonder, even one classed wet");
  assert.equal(isIsthmus(at("h"), EXPLORATION), true, "hill");
  assert.equal(isIsthmus(m.at("1"), EXPLORATION), true, "flat");
});

test("rule: ice and Thera aren't a shore", () => {
  const m = drawMap(`
* * * ~ T T
 1 . 2 . 3 .
. . . . . .
`);
  assert.equal(isIsthmus(m.at("1"), EXPLORATION), false, "only ice beside it");
  assert.equal(isIsthmus(m.at("2"), EXPLORATION), true, "ice on one side, open coast on the other");
  assert.equal(isIsthmus(m.at("3"), EXPLORATION), false, "only Thera beside it");
});

test("rule: a settlement centre counts as a shore, and as the water a run reaches", () => {
  const m = drawMap(`
. . . . . . .
 . 1 C . . . 2
. . . . . . .
`);
  assert.equal(isIsthmus(m.at("1"), ANTIQUITY), true, "beside the centre, no water anywhere");
  assert.equal(isIsthmus(m.at("2"), ANTIQUITY), false, "far from the centre");
  const r = drawMap(`
. . . . . .
 . C = 1 . .
. . . . . .
`);
  assert.equal(isIsthmus(r.at("1"), EXPLORATION), true, "a run of two that reaches only the centre");
  assert.equal(isIsthmus(r.at("1"), ANTIQUITY), false);
});

test("rule: the longest run is 1, 2 and 5 tiles by age, and 1 for the one-tile Canal", () => {
  const max = (age, type = "") => { drawMap("~ .", { age }); return ruleFor(type).max; };
  assert.deepEqual([max(0), max(1), max(2)], [1, 2, 5]);
  assert.deepEqual([0, 1, 2].map((age) => max(age, "BUILDING_CANAL_ONE_TILE")), [1, 1, 1]);
});

test("rule: beside a canal a tile is judged by the run, never as a shore of its own", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~ ~
 . = 1 . . . .
. . 2 . . . .
 . . . . . . .
`);
  assert.equal(isIsthmus(m.at("1"), ANTIQUITY), false, "Antiquity: nothing beside a canal, sea or not");
  assert.equal(isIsthmus(m.at("1"), EXPLORATION), true, "the second tile of a run");
  assert.equal(isIsthmus(m.at("2"), EXPLORATION), true, "inland, reaching the sea through the canal");
  assert.equal(isIsthmus(m.at("2"), ANTIQUITY), false);
});

test("rule: runs of 2 and 5 are full; a queued Canal counts as part of the run", () => {
  const full2 = drawMap(`
~ ~ ~ ~ ~ ~ ~
 . = = 1 . . .
. . . . . . .
`);
  assert.equal(isIsthmus(full2.at("1"), EXPLORATION), false, "a third tile in Exploration");
  assert.equal(isIsthmus(full2.at("1"), MODERN), true);
  const queued = drawMap(`
~ ~ ~ ~ ~ ~ ~
 . + + 1 . . .
. . . . . . .
`);
  assert.equal(isIsthmus(queued.at("1"), EXPLORATION), false, "two queued Canals fill an Exploration run");
  assert.equal(isIsthmus(queued.at("1"), MODERN), true);
  const four = drawMap(" ~ ~ ~ ~ ~ ~ ~ ~ ~\n. = = = = 1 . . .");
  assert.equal(isIsthmus(four.at("1"), MODERN), true, "the fifth tile in Modern");
  const five = drawMap(" ~ ~ ~ ~ ~ ~ ~ ~ ~\n. = = = = = 1 . .");
  assert.equal(isIsthmus(five.at("1"), MODERN), false, "a sixth tile in Modern");
});

test("rule: with no rule given, the age in play decides", () => {
  const map = " ~ ~ ~ ~ ~ ~ ~\n. = = 1 . . .";
  assert.equal(isIsthmus(drawMap(map, { age: 1 }).at("1")), false);
  assert.equal(isIsthmus(drawMap(map, { age: 2 }).at("1")), true);
});

test("rule: every tile of a run has to reach natural water through it", () => {
  const m = drawMap(`
. . . . . . .
 . . + 1 . . .
. . . . . . .
`);
  assert.equal(isIsthmus(m.at("1"), MODERN), false, "beside a queued Canal with no water anywhere");
});

test("rule: park land passes the shape rule; National Park's own list keeps it out", () => {
  const m = drawMap(`
~ ~ ~ ~ ~
 . 1 2 . .
. . . . .
`, { parks: ["1"] });
  assert.equal(isIsthmus(m.at("1"), EXPLORATION), true);
  assert.equal(isParkland(m.at("1")), true);
  assert.equal(isParkland(m.at("2")), false);
  globalThis.__towerNationalPark = { parks: () => { throw new Error("not ready"); } };
  assert.equal(isParkland(m.at("1")), false, "a National Park that throws holds no land");
  delete globalThis.__towerNationalPark;
  assert.equal(isParkland(m.at("1")), false, "without National Park");
});

// runOf

test("runOf: the opened canals joined to a tile, and only those", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~ ~
 . = = . = . .
. . = + . . .
`);
  const [a, b, lone, c] = m.all("=");
  assert.deepEqual(plots(runOf(a)), plots([a, b, c]), "three opened tiles, not the queued one beside them");
  assert.deepEqual(plots(runOf(lone)), plots([lone]), "a canal of its own");
  assert.deepEqual(plots(runOf(m.all(".")[0])), plots([m.all(".")[0]]), "a land tile is a run of itself");
  landAgain(b);
  assert.deepEqual(plots(runOf(a)), plots([a, c]), "a canal turned to land for a save drops out");
});

// channelSides

test("channelSides: a lone canal joins two shores, as nearly opposite as the hex allows", () => {
  const neck = drawMap(`
. . . . .
 . ~ 1 ~ .
. . . . .
`);
  assert.deepEqual(channelSides(neck.at("1"), waterSideIndexes(neck.at("1"))), [0, 3]);
  const star = drawMap(`
~ ~ ~ ~ ~
 ~ 1 ~ ~ ~
~ ~ . ~ ~
`);
  const water = waterSideIndexes(star.at("1"));
  assert.deepEqual(water, [0, 2, 3, 4, 5]);
  assert.deepEqual(channelSides(star.at("1"), water), [0, 3], "water on five sides: two arms straight across");
});

test("channelSides: a run's end takes the way in most nearly opposite its canal", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~
 . = = ~ ~ ~
. . . . . .
`);
  const end = m.all("=")[1];
  assert.deepEqual(waterSideIndexes(end), [0, 3, 4, 5]);
  assert.deepEqual(channelSides(end, waterSideIndexes(end)), [0, 3]);
});

test("channelSides: a junction keeps an arm to each of its canals and nothing else", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~
 . = . . . .
. . = = . .
 . = . . . .
~ ~ ~ ~ ~ ~
`, { age: 2 });
  const hub = m.all("=")[1];
  assert.deepEqual(channelSides(hub, waterSideIndexes(hub), [0, 2, 4]), [0, 2, 4]);
});

test("channelSides: one stretch of shore holding two bodies of water is split by area", () => {
  const m = drawMap(`
. . r r r .
 . . 1 ~ ~ .
. . . ~ ~ .
`);
  const water = waterSideIndexes(m.at("1"));
  assert.deepEqual(water, [0, 1, 4, 5]);
  assert.deepEqual(channelSides(m.at("1"), water), [1, 4], "the sea at SE to the river at NW");
});

// runArms

test("runArms: a straight two-tile cut is one channel from sea to sea", () => {
  const m = drawMap(`
~ ~ ~ ~ ~
 . = . . .
. = . . .
 ~ ~ ~ ~ ~
`);
  const [top, bottom] = m.all("=");
  assert.deepEqual(armsOf(top), [2, 5]);
  assert.deepEqual(armsOf(bottom), [2, 5]);
});

test("runArms: a lake touching both tiles gets one branch, kept off a cliff edge", () => {
  const lake = `
~ ~ ~ ~ ~
 . = . . .
. = ~ . .
 ~ . . . .
~ ~ ~ ~ ~
`;
  let m = drawMap(lake);
  let [top, bottom] = m.all("=");
  assert.deepEqual(armsOf(top), [1, 2, 5], "the branch goes from the first tile");
  assert.deepEqual(armsOf(bottom), [2, 5]);
  m = drawMap(lake);
  [top, bottom] = m.all("=");
  setCliffs(top, [1]);
  assert.deepEqual(armsOf(top), [2, 5]);
  assert.deepEqual(armsOf(bottom), [0, 2, 5], "with a cliff on that edge the other tile takes it");
});

test("runArms: open sea all round a canal is one shore, with no spokes", () => {
  const m = drawMap(`
~ ~ ~ ~ ~
 ~ = ~ ~ ~
~ ~ . ~ ~
`);
  assert.deepEqual(armsOf(m.all("=")[0]), [0, 3]);
});

test("runArms: a Modern junction joins every canal at the hub", () => {
  const m = drawMap(`
~ ~ ~ ~ ~ ~
 . = . . . .
. . = = . .
 . = . . . .
~ ~ ~ ~ ~ ~
`, { age: 2 });
  const [north, hub, east, south] = m.all("=");
  assert.deepEqual(armsOf(hub), [0, 2, 4]);
  assert.deepEqual(armsOf(north), [1, 4]);
  assert.deepEqual(armsOf(east), [3], "a dead end has its one link");
  assert.deepEqual(armsOf(south), [2, 5]);
});

// canalWorth

test("canalWorth: one shore is worth nothing", () => {
  const m = drawMap(`
~ ~ ~ ~ ~
 . 1 . . .
. . . . .
`);
  assert.deepEqual(canalWorth(m.at("1")), { worth: 0, why: "one shore" });
});

test("canalWorth: two shores of one sea are worth the sailing saved, from six tiles up", () => {
  const short = drawMap(`
~ ~ ~ ~ ~ ~ ~ ~
 . 1 . ~ . . . .
~ ~ ~ ~ ~ ~ ~ ~
`);
  assert.deepEqual(canalWorth(short.at("1")), { worth: 0, why: "saves 2" });
  const long = drawMap(`
~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
 . 1 . . . . . . . . ~ ~
~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~
`);
  assert.deepEqual(canalWorth(long.at("1")), { worth: 16, why: "saves 16" });
});

test("canalWorth: joining two bodies of water is worth the smaller one, from ten tiles up", () => {
  const six = drawMap(`
. . . . . . . . . .
 . ~ ~ ~ ~ ~ ~ . . .
. ~ ~ ~ ~ ~ ~ . . .
 . . . 1 . . . . . .
. . ~ ~ ~ ~ ~ ~ . .
 . . . . . . . . . .
`);
  assert.deepEqual(canalWorth(six.at("1")), { worth: 0, why: "joins a body of 6" });
  const ten = drawMap(`
. . . . . . . . . .
 . ~ ~ ~ ~ ~ ~ . . .
. ~ ~ ~ ~ ~ ~ . . .
 . . . 1 . . . . . .
. . ~ ~ ~ ~ ~ . . .
 . . ~ ~ ~ ~ ~ . . .
. . . . . . . . . .
`);
  assert.deepEqual(canalWorth(ten.at("1")), { worth: 10, why: "joins a body of 10" });
});

test("canalWorth: two seas that never meet within reach count as far round", () => {
  const strip = ["~ ".repeat(64), ". ".repeat(32) + "1 " + ". ".repeat(31), "~ ".repeat(64)].join("\n");
  assert.deepEqual(canalWorth(drawMap(strip).at("1")), { worth: 30, why: "far round" });
});

// isObsolete

test("overbuild: an earlier-age building goes, an ageless one or a Dam stays", () => {
  const { isObsolete } = canals;
  drawMap(`
~ ~
 . .
`, { age: 1 });
  assert.equal(isObsolete("BUILDING_LIBRARY"), true, "an Antiquity Library in Exploration");
  assert.equal(isObsolete("BUILDING_PALACE"), false, "an ageless Palace");
  assert.equal(isObsolete("BUILDING_DAM_ANTIQUITY"), false, "an Antiquity Dam");
  assert.equal(isObsolete("BUILDING_ACADEMY"), false, "a building of the age");
  assert.equal(isObsolete("IMPROVEMENT_FARM"), false, "no age at all");
  drawMap(`
~ ~
 . .
`, { age: 2 });
  assert.equal(isObsolete("BUILDING_ACADEMY"), true, "an Exploration Academy in Modern");
  assert.equal(isObsolete("BUILDING_DAM_EXPLORATION"), false, "an Exploration Dam in Modern");
});

// plainBuilding

test("plain building: one held to a terrain, a feature, a resource or a civilization isn't plain", () => {
  const { plainBuilding } = canals;
  drawMap(`
~ ~
 . .
`, { age: 1 });
  const def = (t) => GameInfo.Constructibles.lookup(t);
  assert.equal(plainBuilding(def("BUILDING_MARKET")), true, "a Market goes anywhere a building goes");
  assert.equal(plainBuilding(def("BUILDING_TERRACE")), false, "held to hills");
  assert.equal(plainBuilding(def("BUILDING_SAWPIT")), false, "held to forest");
  assert.equal(plainBuilding(def("BUILDING_MINT")), false, "held to silver");
  assert.equal(plainBuilding(def("BUILDING_UNIQUE")), false, "a civilization's own");
  assert.equal(plainBuilding(def("BUILDING_LIBRARY")), false, "an earlier age's");
});
