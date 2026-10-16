// fake-game.mjs - Canals: just enough of the game's script API to run the placement rule and the channel geometry
// in ui/canals.js under Node.
//
// A map is drawn as hex rows ("odd-r": each odd row sits half a hex to the right, so it is written indented by one
// space), one character per tile:
//
//   ~ coast           * coast under ice     T Thera (a natural wonder in the sea)
//   . flat land       h hill                ^ mountain       f flat with forest       z Zhangjiajie (a land wonder)
//   r navigable river C a settlement centre
//   = an opened canal (coast, on the open record, keeping the land's area id)
//   + a queued canal (flat land on the pending list)
//   1-9 a named flat tile, read back with map.at("1")
//
// Area ids are filled in the way the engine leaves them in a game: one per connected body of water and one per
// landmass, with an opened canal counted as the land it was cut from.
//
// loadCanals() imports the game scripts in ui/ (or in the folder CANALS_UI names, for a deliberately broken scratch
// copy; it needs a package.json with "type": "module" beside or above it) the way the game loads them: canals.js
// first, which imports the rest. The mod's absolute "/tower-canals/ui/" imports resolve to the same folder. The shipped
// files are read, never written. `install()` is kept from running by an existing globalThis.__canals.
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RING = ["DIRECTION_EAST", "DIRECTION_SOUTHEAST", "DIRECTION_SOUTHWEST", "DIRECTION_WEST",
  "DIRECTION_NORTHWEST", "DIRECTION_NORTHEAST"];
// Neighbour offsets by ring index; y grows downward, so the ring runs clockwise on the page.
const STEP_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const STEP_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];

function table(key, rows) {
  const list = rows.map((r, i) => ({ ...r, $index: i }));
  return {
    lookup: (k) => (typeof k === "number" ? list[k] : list.find((r) => r[key] === k)) ?? null,
    find: (f) => list.find(f),
    filter: (f) => list.filter(f),
    forEach: (f) => list.forEach(f),
    [Symbol.iterator]: () => list[Symbol.iterator]()
  };
}

const TERRAINS = ["TERRAIN_MOUNTAIN", "TERRAIN_HILL", "TERRAIN_FLAT", "TERRAIN_COAST", "TERRAIN_OCEAN",
  "TERRAIN_NAVIGABLE_RIVER"];
const FEATURES = [
  { FeatureType: "FEATURE_ICE", Impassable: true },
  { FeatureType: "FEATURE_THERA", Impassable: true },
  { FeatureType: "FEATURE_FOREST", FeatureClassType: "FEATURE_CLASS_VEGETATED" },
  { FeatureType: "FEATURE_ZHANGJIAJIE", FeatureClassType: "FEATURE_CLASS_WET" },
  { FeatureType: "FEATURE_CANALS_SITE" },
  { FeatureType: "FEATURE_CANALS_SITE_ONE_TILE" },
  { FeatureType: "FEATURE_DAMS_SITE" }
];
const AGES = ["AGE_ANTIQUITY", "AGE_EXPLORATION", "AGE_MODERN"];

const TILE = {
  "~": { terrain: "TERRAIN_COAST" },
  "*": { terrain: "TERRAIN_COAST", feature: "FEATURE_ICE" },
  "T": { terrain: "TERRAIN_COAST", feature: "FEATURE_THERA" },
  ".": { terrain: "TERRAIN_FLAT" },
  "h": { terrain: "TERRAIN_HILL" },
  "^": { terrain: "TERRAIN_MOUNTAIN" },
  "f": { terrain: "TERRAIN_FLAT", feature: "FEATURE_FOREST" },
  "z": { terrain: "TERRAIN_FLAT", feature: "FEATURE_ZHANGJIAJIE" },
  "r": { terrain: "TERRAIN_NAVIGABLE_RIVER" },
  "C": { terrain: "TERRAIN_FLAT", district: "DISTRICT_CITY_CENTER" },
  "=": { terrain: "TERRAIN_COAST", canal: "open" },
  "+": { terrain: "TERRAIN_FLAT", canal: "queued" }
};

const isWaterTerrain = (t) => t === "TERRAIN_COAST" || t === "TERRAIN_OCEAN";

/** The game state the script reads: the map, the save's GameConfiguration values, the age and National Park; the
 * settlements, the local player's techs, and the model groups drawn. */
const world = { W: 0, H: 0, tiles: [], config: new Map(), age: 1, parks: null, cities: new Map(), techs: new Set(),
  groups: [] };

const inside = (x, y) => x >= 0 && y >= 0 && x < world.W && y < world.H;
const tileAt = (x, y) => (inside(x, y) ? world.tiles[y * world.W + x] : null);
function step(x, y, ring) {
  const [dx, dy] = (y & 1 ? STEP_ODD : STEP_EVEN)[ring];
  return { x: x + dx, y: y + dy };
}
function cube(x, y) { const q = x - (y - (y & 1)) / 2; return [q, y, -q - y]; }

const GameplayMap = {
  getGridWidth: () => world.W,
  getGridHeight: () => world.H,
  getIndexFromLocation: (l) => l.y * world.W + l.x,
  getLocationFromIndex: (i) => ({ x: i % world.W, y: Math.floor(i / world.W) }),
  getTerrainType: (x, y) => TERRAINS.indexOf(tileAt(x, y).terrain),
  getFeatureType: (x, y) => {
    const f = tileAt(x, y).feature;
    return f ? FEATURES.findIndex((r) => r.FeatureType === f) : -1;
  },
  getResourceType: (x, y) => (tileAt(x, y).resource ? 0 : -1),
  isWater: (x, y) => isWaterTerrain(tileAt(x, y).terrain),
  isNavigableRiver: (x, y) => tileAt(x, y).terrain === "TERRAIN_NAVIGABLE_RIVER",
  getAreaId: (x, y) => tileAt(x, y).area,
  getAdjacentPlotLocation: (l, d) => {
    const n = step(l.x, l.y, d);
    return inside(n.x, n.y) ? n : { x: -1, y: -1 };
  },
  getPlotIndicesInRadius: (x, y, r) => {
    if (r !== 1) throw new Error("fake map: radius 1 only");
    const out = [y * world.W + x];
    for (let d = 0; d < 6; d++) { const n = step(x, y, d); if (inside(n.x, n.y)) out.push(n.y * world.W + n.x); }
    return out;
  },
  getPlotDistance: (x1, y1, x2, y2) => {
    const a = cube(x1, y1), b = cube(x2, y2);
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }
};

const GLOBALS = {
  GameplayMap,
  GameInfo: {
    Terrains: table("TerrainType", TERRAINS.map((TerrainType) => ({ TerrainType }))),
    Features: table("FeatureType", FEATURES),
    Feature_NaturalWonders: [{ FeatureType: "FEATURE_THERA" }, { FeatureType: "FEATURE_ZHANGJIAJIE" }],
    Districts: table("DistrictType", [{ DistrictType: "DISTRICT_CITY_CENTER" }, { DistrictType: "DISTRICT_URBAN" },
      { DistrictType: "DISTRICT_RURAL" }]),
    Ages: table("AgeType", AGES.map((AgeType) => ({ AgeType }))),
    // a few buildings for isObsolete; like the game's tables, these have no some()
    Constructibles: table("ConstructibleType", [
      { ConstructibleType: "BUILDING_LIBRARY", Age: "AGE_ANTIQUITY" },
      { ConstructibleType: "BUILDING_PALACE", Age: "AGE_ANTIQUITY" },
      { ConstructibleType: "BUILDING_DAM_ANTIQUITY", Age: "AGE_ANTIQUITY" },
      { ConstructibleType: "BUILDING_DAM_EXPLORATION", Age: "AGE_EXPLORATION" },
      { ConstructibleType: "BUILDING_ACADEMY", Age: "AGE_EXPLORATION" },
      // two Antiquity warehouses: the Granary keeps its AGELESS tag, the Brickyard has lost it the way Warehouse
      // Overbuilding (3517656064) deletes it once the age is over
      { ConstructibleType: "BUILDING_GRANARY", Age: "AGE_ANTIQUITY" },
      { ConstructibleType: "BUILDING_BRICKYARD", Age: "AGE_ANTIQUITY" },
      { ConstructibleType: "IMPROVEMENT_FARM", ConstructibleClass: "IMPROVEMENT" },
      // and for plainBuilding: one with no placement rule, one each held to a terrain, a feature and a resource,
      // one tied to a civilization's trait
      { ConstructibleType: "BUILDING_MARKET", ConstructibleClass: "BUILDING", Age: "AGE_EXPLORATION" },
      { ConstructibleType: "BUILDING_TERRACE", ConstructibleClass: "BUILDING", Age: "AGE_EXPLORATION" },
      { ConstructibleType: "BUILDING_SAWPIT", ConstructibleClass: "BUILDING", Age: "AGE_EXPLORATION" },
      { ConstructibleType: "BUILDING_MINT", ConstructibleClass: "BUILDING", Age: "AGE_EXPLORATION" },
      { ConstructibleType: "BUILDING_UNIQUE", ConstructibleClass: "BUILDING", Age: "AGE_EXPLORATION" }]),
    Buildings: table("ConstructibleType", [{ ConstructibleType: "BUILDING_MARKET" },
      { ConstructibleType: "BUILDING_UNIQUE", TraitType: "TRAIT_SOMEONE" }]),
    Constructible_RequiredFeatures: table("ConstructibleType", []),
    Constructible_RequiredFeatureClasses: table("ConstructibleType", []),
    Constructible_ValidTerrains: table("ConstructibleType", [{ ConstructibleType: "BUILDING_TERRACE", TerrainType: "TERRAIN_HILL" }]),
    Constructible_ValidBiomes: table("ConstructibleType", []),
    Constructible_ValidFeatures: table("ConstructibleType", [{ ConstructibleType: "BUILDING_SAWPIT", FeatureType: "FEATURE_FOREST" }]),
    Constructible_ValidResources: table("ConstructibleType", [{ ConstructibleType: "BUILDING_MINT", ResourceType: "RESOURCE_SILVER" }]),
    ProgressionTreeNodes: table("ProgressionTreeNodeType", [{ ProgressionTreeNodeType: "NODE_TECH_EX_SHIPBUILDING" },
      { ProgressionTreeNodeType: "NODE_TECH_EX_CARTOGRAPHY" }]),
    ProgressionTreeNodeUnlocks: table("TargetType", [{ TargetType: "BUILDING_MARKET",
      ProgressionTreeNodeType: "NODE_TECH_EX_SHIPBUILDING" }]),
    TypeTags: table("Type", [{ Type: "BUILDING_PALACE", Tag: "AGELESS" }, { Type: "BUILDING_GRANARY", Tag: "AGELESS" },
      { Type: "BUILDING_LIBRARY", Tag: "SCIENCE" }])
  },
  Game: { get age() { return world.age; } },
  Configuration: {
    getGame: () => ({ getValue: (k) => world.config.get(k) ?? null, isNetworkMultiplayer: false }),
    editGame: () => ({ setValue: (k, v) => world.config.set(k, v) })
  },
  Districts: {
    getAtLocation: (l) => {
      const d = tileAt(l.x, l.y).district;
      return d ? { type: GLOBALS.GameInfo.Districts.lookup(d).$index } : null;
    }
  },
  MapConstructibles: { getConstructibles: (x, y) => (tileAt(x, y).builds || []).map((type, i) => ({ x, y, i })) },
  Constructibles: {
    getByComponentID: (c) => ({ type: GLOBALS.GameInfo.Constructibles.lookup(tileAt(c.x, c.y).builds[c.i]).$index,
      owner: 0, localId: c.i, complete: true })
  },
  MapUnits: { getUnits: (x, y) => tileAt(x, y).units || [] },
  Cities: { get: (id) => world.cities.get(id) || null },
  Players: { get: () => ({ Techs: { isNodeUnlocked: (n) => world.techs.has(n) } }) },
  // a model group records what is drawn into it
  WorldUI: {
    createModelGroup: (name) => {
      const g = { name, models: [], addModelAtPlot: (...a) => g.models.push(a), clear: () => {}, destroy: () => {} };
      world.groups.push(g);
      return g;
    }
  },
  PlacementMode: { TERRAIN: "TERRAIN" },
  DirectionTypes: Object.fromEntries(RING.map((d, i) => [d, i])),
  FeatureTypes: { NO_FEATURE: -1 },
  ResourceTypes: { NO_RESOURCE: -1 }
};

/** Area ids as the engine has them: one per body of water, one per landmass (an opened canal counts as land). */
function fillAreas() {
  const wet = (t) => isWaterTerrain(t.terrain) && t.canal !== "open";
  let next = 1;
  for (let i = 0; i < world.tiles.length; i++) {
    if (world.tiles[i].area) continue;
    const kind = wet(world.tiles[i]);
    const stack = [i]; world.tiles[i].area = next;
    while (stack.length) {
      const p = stack.pop(); const x = p % world.W, y = Math.floor(p / world.W);
      for (let d = 0; d < 6; d++) {
        const n = step(x, y, d); const t = tileAt(n.x, n.y);
        if (t && !t.area && wet(t) === kind) { t.area = next; stack.push(n.y * world.W + n.x); }
      }
    }
    next++;
  }
}

/**
 * Lay out a map from its picture (see the top of this file) and make it the one the script reads. `age` is 0, 1 or 2
 * (Antiquity, Exploration, Modern); `parks` names the tiles National Park holds.
 */
export function drawMap(picture, { age = 1, parks = null } = {}) {
  const rows = picture.split("\n").filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
  const W = rows[0].length;
  if (rows.some((r) => r.length !== W)) throw new Error("fake map: rows of different lengths");
  world.W = W; world.H = rows.length; world.config = new Map(); world.age = age;
  world.cities = new Map(); world.techs = new Set(); world.groups = [];
  world.parks = parks; world.tiles = [];
  const names = new Map();
  rows.forEach((r, y) => r.forEach((ch, x) => {
    const named = /^[1-9]$/.test(ch);
    if (!named && !TILE[ch]) throw new Error(`fake map: unknown tile "${ch}"`);
    world.tiles.push({ ...(named ? TILE["."] : TILE[ch]) });
    if (named) names.set(ch, { x, y });
  }));
  fillAreas();
  const open = [], pending = [];
  world.tiles.forEach((t, i) => {
    if (t.canal === "open") open.push({ plot: i, age: AGES[age], cliffs: [], land: "TERRAIN_FLAT" });
    if (t.canal === "queued") pending.push(i);
  });
  world.config.set("Canals_Open_v1", JSON.stringify(open));
  world.config.set("Canals_Pending_v1", JSON.stringify(pending));
  if (parks) globalThis.__towerNationalPark = { parks: () => [{ tiles: parks.map((n) => plotOf(names.get(n))) }] };
  else delete globalThis.__towerNationalPark;
  const at = (name) => {
    if (!names.has(name)) throw new Error(`fake map: no tile named ${name}`);
    return { ...names.get(name) };
  };
  /** Every tile drawn with this character, in reading order. */
  const all = (ch) => {
    const out = [];
    rows.forEach((r, y) => r.forEach((c, x) => { if (c === ch) out.push({ x, y }); }));
    return out;
  };
  return { at, all, plot: (name) => plotOf(at(name)), next: (l, ring) => step(l.x, l.y, ring) };
}

export function plotOf(l) { return l.y * world.W + l.x; }

/** Put things on a tile: `district` (DISTRICT_URBAN or DISTRICT_RURAL), `builds` (constructible types), `units` (any
 * list), `resource` (true). */
export function setTile(l, props) { Object.assign(tileAt(l.x, l.y), props); }

/** A settlement of the local player (id, centre) holding the plots listed, or every land plot within three tiles. */
export function addCity(id, centre, plots = null) {
  const own = plots || world.tiles.map((_, i) => i).filter((i) => {
    const x = i % world.W, y = Math.floor(i / world.W);
    return GameplayMap.getPlotDistance(centre.x, centre.y, x, y) <= 3;
  });
  world.cities.set(id, { id, owner: 0, location: { ...centre }, getPurchasedPlots: () => own.slice() });
}

/** A tech the local player has researched. */
export function research(node) { world.techs.add(node); }

/** The model groups drawn since the map was laid out: name and every addModelAtPlot call. */
export function drawn() { return world.groups.map((g) => ({ name: g.name, models: g.models })); }

/** Open a canal on a tile of the current map: coast, on the open record, its land's area id kept. */
export function openCanal(l) {
  const t = tileAt(l.x, l.y);
  t.terrain = "TERRAIN_COAST"; t.canal = "open";
  const open = JSON.parse(world.config.get("Canals_Open_v1"));
  open.push({ plot: plotOf(l), age: AGES[world.age], cliffs: [], land: "TERRAIN_FLAT" });
  world.config.set("Canals_Open_v1", JSON.stringify(open));
}

/** The cliff edges (ring indexes) an opened canal's record keeps from before its retype. */
export function setCliffs(l, sides) {
  const open = JSON.parse(world.config.get("Canals_Open_v1"));
  for (const e of open) if (e.plot === plotOf(l)) e.cliffs = sides;
  world.config.set("Canals_Open_v1", JSON.stringify(open));
}

/** An opened canal turned back to land, as it is while a save is written. */
export function landAgain(l) { tileAt(l.x, l.y).terrain = "TERRAIN_FLAT"; }

const UNDER_TEST = ["isIsthmus", "ruleFor", "isParkland", "runOf", "channelSides", "runArms", "canalWorth",
  "waterSideIndexes", "isObsolete", "plainBuilding", "eligiblePlots", "drawOverlay", "clearOverlay", "unlockedByMod"];

/** Import the game scripts against this fake; the functions under test, gathered from the modules that export them. */
export async function loadCanals(dir = process.env.CANALS_UI || path.join(ROOT, "ui")) {
  Object.assign(globalThis, GLOBALS);
  if (!globalThis.__canals) globalThis.__canals = { fake: true }; // keeps install() from running
  const MOD = "/tower-canals/ui/";
  registerHooks({
    resolve: (spec, ctx, next) => (spec.startsWith(MOD)
      ? { url: pathToFileURL(path.join(dir, spec.slice(MOD.length))).href, shortCircuit: true } : next(spec, ctx))
  });
  await import(pathToFileURL(path.join(dir, "canals.js")).href);
  const all = {};
  // the Options row and the main-menu script run in the shell, not here
  for (const f of fs.readdirSync(dir).filter((x) => /^canals-[a-z]+\.js$/.test(x) && !/-(options|shell)\./.test(x)))
    Object.assign(all, await import(pathToFileURL(path.join(dir, f)).href));
  const missing = UNDER_TEST.filter((n) => typeof all[n] !== "function");
  if (missing.length) throw new Error(`not exported by any module in ${dir}: ${missing.join(", ")}`);
  return all;
}
