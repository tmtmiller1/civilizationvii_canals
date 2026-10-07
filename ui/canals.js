// canals.js - Canals, a Civilization VII mod. Game scope.
//
// What it does (the runs behind each step are in docs/verification-runs.md):
//   1. Placement. The Canal buildings (data/canals.xml) carry no terrain rule of their own; this script decides
//      where they may go by wrapping the two calls that place a building: Game.CityOperations BUILD (production)
//      and Game.CityCommands PURCHASE (gold, the only way a town gets a building). For a Canal, the offered plots
//      are the city's land tiles with water on at least two separate sides (a strip of land between coasts, the
//      same sea or not), and the per-plot check refuses anything else. The same verdict is written into
//      canStartQuery, which is what the production and purchase lists are built from. The engine itself takes a Canal
//      only on a tile holding the site marker (data/canals-sites.xml), which the order places: see "canal sites".
//   2. Commit. A Canal BUILD or PURCHASE on an isthmus without an urban district first gets one (CREATE_ELEMENT
//      DISTRICT), then the order is forwarded; if the engine refuses it the district is removed again. The tile is
//      remembered in the save (GameConfiguration key) so a reload mid-construction still finishes the job. A
//      purchased Canal lands complete with no completion event (c36), so the commit opens it.
//   3. Completion. On ConstructibleBuildCompleted for a Canal on an isthmus: the tile is retyped to Coast
//      (WorldBuilder.MapPlots.setTerrain, the feature cleared first), the Canal building and its district are
//      destroyed and the plot bought back, so the finished canal is a bare water hex the city owns that ships path
//      through at once; a canal look (channel, quay, boats) is drawn on it from shipped meshes. A Canal completed on
//      a tile that is not an isthmus (an AI's, or a stale save) is left alone.
//   4. Safety net. On load and at the start of every turn, every remembered tile and every complete Canal on the
//      map is re-checked, so a missed event is caught on the next turn.
//   Multiplayer: the terrain retype is a local call, not a networked operation, so in a network game the Canal is
//   not offered and completed Canals are left as buildings.
//   One-tile mode (Options > Add-ons, ui/canals-settings.js): an alternative to the age rules, not a replacement.
//   The age Canals are not offered; one Canal with no age is (BUILDING_CANAL_ONE_TILE), unlocked by Irrigation in
//   Antiquity and by nothing later, always a single tile, with no ship limit, the same cost and yields in every age,
//   and drawn in the style of the age being played. A canal keeps the rules of the Canal that
//   dug it, so switching the mode mid-game changes only what is offered from then on.
"use strict";

import { getMode, gameHasMode, pinModeToGame } from "/tower-canals/ui/canals-settings.js";

const TAG = "[Canals]";
const G = globalThis;
const KEY = "__canals";
const PERSIST_KEY = "Canals_Pending_v1";
const OPEN_KEY = "Canals_Open_v1";
const ONE_TILE_CANAL = "BUILDING_CANAL_ONE_TILE";
const CANAL_TYPES = ["BUILDING_CANAL_ANTIQUITY", "BUILDING_CANAL_EXPLORATION", "BUILDING_CANAL_MODERN", ONE_TILE_CANAL];
/** What an opened one-tile canal records in place of an age: its rules and its look are the same in every age. */
const ONE_TILE = "ONE_TILE";
const SETTLE_MS = 400;
const BUILD_LAND_MS = 6000;
const BUILD_RADIUS = 3;
/** Ships that may pass a canal per turn, by its age; the local player's orders are the only ones a script can hold. */
const TRANSITS_PER_TURN = { AGE_ANTIQUITY: 1, AGE_EXPLORATION: 2, AGE_MODERN: Infinity, [ONE_TILE]: Infinity };

function log(m) { try { console.error(TAG + " " + m); } catch (_) { /* ignore */ } }

/** Whether the one-tile rules are in play. Read from the store at most twice a second: the Options screen can change it
 * at any time, and the placement rule is asked for every tile of every city. */
let modeRead = { at: 0, oneTile: false };
function oneTileMode() {
  const now = Date.now();
  if (now - modeRead.at > 500) modeRead = { at: now, oneTile: safe(() => getMode() === "one-tile", false) };
  return modeRead.oneTile;
}
function safe(fn, fb) { try { return fn(); } catch (_e) { return fb; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function J(o) { try { return JSON.stringify(o); } catch (_) { return "?"; } }

// map reads

function idx(loc) { return GameplayMap.getIndexFromLocation(loc); }
function locOf(i) { const l = GameplayMap.getLocationFromIndex(i); return { x: l.x, y: l.y }; }
function terrainOf(loc) { return safe(() => String(GameInfo.Terrains.lookup(GameplayMap.getTerrainType(loc.x, loc.y)).TerrainType), "?"); }
function featureOf(loc) { return safe(() => { const f = GameplayMap.getFeatureType(loc.x, loc.y); return f === FeatureTypes.NO_FEATURE ? "" : String(GameInfo.Features.lookup(f).FeatureType); }, ""); }
function isWater(loc) { return safe(() => GameplayMap.isWater(loc.x, loc.y), true); }
function areaOf(loc) { return safe(() => GameplayMap.getAreaId(loc.x, loc.y), null); }
function neighbors(loc) {
  return safe(() => (GameplayMap.getPlotIndicesInRadius(loc.x, loc.y, 1) || []).filter((i) => i !== idx(loc))
    .map(locOf), []);
}
function districtAt(loc) { return safe(() => { const d = Districts.getAtLocation(loc); return d ? String(GameInfo.Districts.lookup(d.type).DistrictType) : ""; }, ""); }
function districtIdAt(loc) { return safe(() => Districts.getIdAtLocation(loc), null); }
function occupants(loc) {
  return safe(() => (MapConstructibles.getConstructibles(loc.x, loc.y) || []).map((c) => {
    const inst = Constructibles.getByComponentID(c);
    const def = GameInfo.Constructibles.lookup(inst.type);
    return {
      type: String(def.ConstructibleType), owner: inst.owner,
      id: inst.localId != null ? inst.localId : inst.id, complete: inst.complete !== false
    };
  }), []);
}
function canalOn(loc) { return occupants(loc).find((o) => CANAL_TYPES.includes(o.type)) || null; }
function isImprovement(type) { return safe(() => String(GameInfo.Constructibles.lookup(type).ConstructibleClass) === "IMPROVEMENT", false); }

/**
 * The water bodies a land tile touches: area id -> one water neighbor, ice excluded.
 * A finished canal keeps the area id of the land it was cut from (the engine never recalculates areas
 * in-turn or on reload), so a water tile whose area id matches the surrounding land is a canal, not a sea; its
 * seas are resolved through its own water neighbors (a few hops, so a chain of canals resolves too).
 */
function waterAreas(loc) {
  const landAreas = new Set([areaOf(loc)]);
  for (const n of neighbors(loc)) if (!isWater(n)) landAreas.add(areaOf(n));
  const m = new Map();
  const visited = new Set([idx(loc)]);
  const walk = (from, depth) => {
    for (const w of neighbors(from)) {
      const p = idx(w);
      if (visited.has(p) || !isWater(w) || impassableFeature(w)) continue;
      visited.add(p);
      const a = areaOf(w);
      if (landAreas.has(a)) { if (depth < 4) walk(w, depth + 1); continue; }
      if (!m.has(a)) m.set(a, w);
    }
  };
  walk(loc, 0);
  return m;
}

const RING = ["DIRECTION_EAST", "DIRECTION_SOUTHEAST", "DIRECTION_SOUTHWEST", "DIRECTION_WEST", "DIRECTION_NORTHWEST", "DIRECTION_NORTHEAST"];

/** A city or town center: a canal end in its own right, like open water (rule 2026-09-25: a settlement can dig a canal
 * from its own tile to the sea or a river, and a run may start or finish at the center). The center itself is
   never dug. */
function isSettlementCentre(loc) { return districtAt(loc) === "DISTRICT_CITY_CENTER"; }
/**
 * The tile's feature lets nothing through (Features.Impassable): ice, and the natural wonders that stand in the sea,
 * Thera and Seongsan Ilchulbong. No ship enters such a tile, so it is no shore: a canal dug to it would open onto a
 * wall. Read once per feature type.
 */
const impassableFeatures = new Map();
function impassableFeature(loc) {
  return safe(() => {
    const f = GameplayMap.getFeatureType(loc.x, loc.y);
    if (f === FeatureTypes.NO_FEATURE) return false;
    if (!impassableFeatures.has(f)) impassableFeatures.set(f, !!GameInfo.Features.lookup(f).Impassable);
    return impassableFeatures.get(f);
  }, false);
}
/** Water a ship can sail: sea, lake, or a navigable river tile (which the engine's water flag does not cover),
 * with nothing impassable on it. */
function isOpenWater(loc) {
  return (isWater(loc) || safe(() => GameplayMap.isNavigableRiver(loc.x, loc.y), false)) && !impassableFeature(loc);
}
/** The same, plus a settlement center, which is a canal end too. */
function isShipWater(loc) { return isOpenWater(loc) || isSettlementCentre(loc); }

/**
 * How many separate ways a ship can reach the hex: walking the six neighbors in ring order, a run of open water
 * (ice not counted) is one way in, and a settlement center beside the tile is one of its own. Two ways in means
 * the tile is a strip of land between two shores, whether or not those shores belong to the same sea: three coast
 * tiles on one side and one on the other is two; five coast tiles in a row (a headland) is one.
 * A center is counted apart from the water rather than as a piece of it. Counted as water it could bridge the gap
 * between a neck's two shores and read them as a single stretch, so founding a settlement next to a neck took the
 * neck's own site away (c48: a Modern town beside a two-shore neck left it unbuildable).
 */
/** A ship-water neighbor in that ring direction. Cliffs do not matter: the retype clears the plot's cliff flags
 * (c21); only their drawn rock faces remain until the next load. */
function openWaterSide(loc, d) {
  const n = safe(() => GameplayMap.getAdjacentPlotLocation(loc, DirectionTypes[d]), null);
  return !!(n && n.x >= 0 && isShipWater(n));
}
/** Ring indexes of the hex's edges that are cliff crossings (read before a retype, which clears them). */
function cliffSideIndexes(loc) {
  const out = [];
  RING.forEach((d, i) => {
    if (safe(() => GameplayMap.isCliffCrossing(loc.x, loc.y, DirectionTypes[d]), false) === true) out.push(i);
  });
  return out;
}
/** The same, with the tile itself given: used by the chain rule. */
function neighborIn(loc, d) {
  const n = safe(() => GameplayMap.getAdjacentPlotLocation(loc, DirectionTypes[d]), null);
  return n && n.x >= 0 ? { x: n.x, y: n.y } : null;
}

function waterStretches(loc) {
  const ring = RING.map((d) => neighborIn(loc, d));
  const water = ring.map((n) => !!(n && isOpenWater(n)));
  let runs = 0;
  for (let i = 0; i < 6; i++) if (water[i] && !water[(i + 5) % 6]) runs++;
  if (runs === 0 && water.every(Boolean)) runs = 1;
  return runs + ring.filter((n, i) => n && !water[i] && isSettlementCentre(n)).length;
}

/**
 * A tile holding a resource can take no building at all: the engine refuses every building on it, in a city or a
 * town, built or bought, even with an urban district in place, and gives no reason (c53 to c55: Canal,
 * Grocer and Fishing Quay refused on an ivory and a wine tile, all three taken on a plain tile beside them; not one
 * urban tile on the whole map held a resource). The Canal is a building, and a script cannot clear a resource
 * (ResourceBuilder is map-generation only), so such a tile is never offered.
 */
function hasResource(loc) {
  return safe(() => GameplayMap.getResourceType(loc.x, loc.y) !== ResourceTypes.NO_RESOURCE, false);
}

/**
 * National Park land is never a canal site. National Park also refuses buildings on its land by wrapping canStart
 * and sendRequest, but when its wrappers sit inside these ones its filter comes too late: this mod replaces the plot
 * list, and a build on park land would clear the park's improvement before National Park refused it. Asking the
 * mod directly, at call time, holds whichever script wrapped the engine calls last.
 */
function isParkland(loc) {
  const np = G.__towerNationalPark;
  if (!np || typeof np.parks !== "function") return false;
  const plot = idx(loc);
  return safe(() => np.parks().some((p) => Array.isArray(p.tiles) && p.tiles.includes(plot)), false);
}

/**
 * Whether a canal may clear the tile's feature: vegetation, wetland and floodplain go when the tile turns to water.
 * A natural wonder is never dug away, whatever class it carries (Zhangjiajie is classed wet, the Barrier Reef
 * vegetated), and nor is anything else without one of those classes (a volcano, ice).
 */
let wonderFeatures = null;
function clearableFeature(loc) {
  const f = featureOf(loc);
  // a site marker (this mod's, or Dams' on a river tile) is only a marker
  if (!f || SITE_FEATURES.includes(f) || f === "FEATURE_DAMS_SITE") return true;
  if (!wonderFeatures) {
    const rows = safe(() => Array.from(GameInfo.Feature_NaturalWonders), []);
    wonderFeatures = new Set(rows.map((r) => String(r.FeatureType)));
  }
  if (wonderFeatures.has(f)) return false;
  const cls = safe(() => String(GameInfo.Features.lookup(f).FeatureClassType || ""), "");
  return cls === "FEATURE_CLASS_VEGETATED" || cls === "FEATURE_CLASS_WET" || cls === "FEATURE_CLASS_FLOODPLAIN";
}

/** Land a canal can be cut through: flat or hill (never a mountain), not a navigable river, no feature it must keep. */
function isCuttable(loc) {
  if (isWater(loc)) return false;
  const tt = terrainOf(loc);
  if (tt !== "TERRAIN_FLAT" && tt !== "TERRAIN_HILL") return false;
  if (!clearableFeature(loc)) return false;
  return !safe(() => GameplayMap.isNavigableRiver(loc.x, loc.y), false);
}

function currentAge() { return safe(() => String(GameInfo.Ages.lookup(Game.age).AgeType), "AGE_ANTIQUITY"); }

/** Most tiles a canal run may have, by age; whether it must be a straight line; whether it may branch. */
const CHAIN_RULES = {
  AGE_ANTIQUITY: { max: 1, straight: true, branch: false },
  AGE_EXPLORATION: { max: 2, straight: true, branch: false },
  AGE_MODERN: { max: 5, straight: false, branch: true }
};
/** The one-tile mode's rule, in every age: Antiquity's. */
const ONE_TILE_RULE = CHAIN_RULES.AGE_ANTIQUITY;

/** The rule a Canal of this type is judged by: the one-tile Canal by its own, the age Canals by the age in play. */
function ruleFor(type) {
  if (type === ONE_TILE_CANAL) return ONE_TILE_RULE;
  return CHAIN_RULES[currentAge()] || CHAIN_RULES.AGE_ANTIQUITY;
}
/** The rule for a new Canal: the mode's. */
function placementRule() { return ruleFor(oneTileMode() ? ONE_TILE_CANAL : ""); }

/** Plots that are canal tiles: opened ones (now coast) and queued ones (still land, counted so canals can be built
    in sequence). */
function canalPlots() {
  const s = new Set();
  for (const e of loadOpen()) s.add(e.plot); for (const p of loadPending()) s.add(p);
  return s;
}

/** Ship-water that is not a canal of ours: sea, lake, navigable river. */
function isNaturalWater(loc, canals) { return isShipWater(loc) && !canals.has(idx(loc)); }

/**
 * The placement rule.
 * Antiquity: a single tile with water on at least two separate sides (a strip of land between two shores), never
 * beside another canal.
 * Exploration: the same, or a tile beside one canal (opened or queued) that makes a straight two-tile line with
 * it; no third tile, no bend, no branch.
 * Modern: a tile touching water or a canal, as long as the run it joins has at most five tiles and touches
 * natural water; runs may bend and branch.
 * One-tile mode: Antiquity's rule, in every age. `rule` defaults to the rule for a new Canal; a finished one is judged
 * by the rule of its own type (ruleFor).
 * A tile beside a canal always joins that canal's run and is judged by the run rule: a canal's own water never
 * makes its neighbor a two-shore isthmus on its own (gal-exp: that hole let a fourth tile onto a run's
 * side and drew a branched blob in the Exploration age).
 */
function isIsthmus(loc, rule = placementRule()) {
  if (!isCuttable(loc)) return false;
  const canals = canalPlots();
  const besideCanal = RING.some((d) => { const n = neighborIn(loc, d); return n && canals.has(idx(n)); });
  if (!besideCanal) return waterStretches(loc) >= 2 || waterAreas(loc).size >= 2;
  if (rule.max <= 1) return false;
  const me = idx(loc);
  // the run of canal tiles this tile would join
  const comp = new Set([me]); const queue = [loc];
  while (queue.length) {
    const c = queue.pop();
    for (const d of RING) {
      const n = neighborIn(c, d); if (!n) continue;
      const p = idx(n); if (canals.has(p) && !comp.has(p)) { comp.add(p); queue.push(n); }
    }
  }
  if (comp.size > rule.max) return false;
  // every tile of the run must reach natural water through the run
  const dist = new Map(); const q2 = [];
  for (const p of comp) {
    const l = locOf(p);
    if (RING.some((d) => { const n = neighborIn(l, d); return n && isNaturalWater(n, canals); })) {
      dist.set(p, 1); q2.push(p);
    }
  }
  while (q2.length) {
    const p = q2.shift(); const l = locOf(p);
    for (const d of RING) {
      const n = neighborIn(l, d); if (!n) continue;
      const np = idx(n); if (comp.has(np) && !dist.has(np)) { dist.set(np, dist.get(p) + 1); q2.push(np); }
    }
  }
  for (const p of comp) if (!dist.has(p)) return false;
  // the run's shape: links per tile (a branch is three), and in a straight run the two links are opposite sides
  for (const p of comp) {
    const links = [];
    RING.forEach((d, i) => { const n = neighborIn(locOf(p), d); if (n && comp.has(idx(n))) links.push(i); });
    if (!rule.branch && links.length > 2) return false;
    if (rule.straight && links.length === 2 && (links[1] - links[0]) !== 3) return false;
  }
  return true;
}

// persistence

/** Remembered Canal sites (plot indexes), kept in the save so a reload mid-construction still completes. */
function loadPending() {
  return safe(() => {
    const v = Configuration.getGame().getValue(PERSIST_KEY); const a = v ? JSON.parse(String(v)) : [];
    return Array.isArray(a) ? a : [];
  }, []);
}
function savePending(list) { safe(() => Configuration.editGame().setValue(PERSIST_KEY, JSON.stringify(list))); }
function remember(plot) { const l = loadPending(); if (!l.includes(plot)) { l.push(plot); savePending(l); } }
function forget(plot) {
  const l = loadPending(); const n = l.filter((p) => p !== plot);
  if (n.length !== l.length) savePending(n);
}
/** Canals opened so far (plot indexes), kept in the save so their overlay is redrawn after a load. */
function loadOpen() { return safe(() => { const v = Configuration.getGame().getValue(OPEN_KEY); const a = v ? JSON.parse(String(v)) : []; return Array.isArray(a) ? a.map((e) => (typeof e === "number" ? { plot: e, age: "AGE_ANTIQUITY" } : e)) : []; }, []); }
function rememberOpen(plot, age, cliffs, land) {
  const l = loadOpen();
  if (!l.some((e) => e.plot === plot)) {
    l.push({ plot, age, cliffs: cliffs || [], land: land || "TERRAIN_FLAT" });
    safe(() => Configuration.editGame().setValue(OPEN_KEY, JSON.stringify(l)));
    holdEngineAutosave();
  }
}

// the canal itself

const state = {
  enabled: true, originals: null, canalIndexes: new Set(), busy: new Set(),
  // canals opened in this session: their cliff faces are still drawn (a load redraws the hex without them)
  openedHere: new Set(),
  // canals whose hex is drawn as land this session: opened in it, or loaded as land (see keepLandLook)
  landMesh: new Set(), saving: false, hold: false, loading: false, pendingSave: false, syncing: false, localId: -1,
  multiplayer: false, paidTurn: -1, transits: new Map(), transitTurn: -1,
  // the age has ended (GameAgeEnded); the canals stay land for the transition
  ageEnded: false, repairing: false,
  // the autosave the mod's newest one pushes past the player's keep count, deleted once the new one is written
  prune: null,
  // canals a save held as Coast (Canals 1.0.0), turned to land as the game loaded
  staleLoad: [],
  // messages shown this session (a network game keeps no record of its own)
  told: new Set(),
  // the autosave to load once it is written (offerReload)
  reloadFrom: null
};

function canalIndex(v) { return state.canalIndexes.has(v); }

/** A save is being written, or is about to be: the save thread reads the map, and no map write may meet it. */
function saveInFlight() { return state.saving || state.pendingSave; }

/**
 * Map edits in one WorldBuilder block. The block is closed whatever fn does: left open by a throw, every later edit
 * of the session would sit inside it.
 */
function withBlock(fn) {
  let open = false;
  try { WorldBuilder.startBlock(); open = true; fn(); } finally { if (open) safe(() => WorldBuilder.endBlock()); }
}

/** Retype a land tile to Coast; resolves true when the read confirms it. Never while a save runs (see keeping the
 * land look): the canal then waits for the next sweep. */
async function flipToCoast(loc) {
  const coast = safe(() => GameInfo.Terrains.lookup("TERRAIN_COAST").$index, -1);
  if (coast < 0) return false;
  if (saveInFlight()) { log(`Canal at ${loc.x},${loc.y}: a save is being written; the canal opens at the next sweep`); return false; }
  try {
    withBlock(() => {
      if (featureOf(loc)) WorldBuilder.MapPlots.setFeature(FeatureTypes.NO_FEATURE, loc);
      WorldBuilder.MapPlots.setTerrain(coast, loc);
    });
  } catch (e) { log("setTerrain threw " + e); return false; }
  // The engine applies the edit on its own tick: usually within 200 ms, but an owned tile has taken seconds (fx2,
  // 2026-09-30: over 3 s twice, then 220 ms once the game was idle). A late edit is adopted by openCanal.
  for (let k = 0; k < 100; k++) { await sleep(100); if (terrainOf(loc) === "TERRAIN_COAST") return true; }
  return false;
}

/**
 * A Canal has completed on `loc`: make it a canal. Owner may be any player; the local client does the work
 * (single player only, see the multiplayer note above).
 */
/**
 * The local player's turn is under way. The mod's map edits are requests sent as the local player, and an opening
 * that ran on as the turn ended lost its district and its Canal building (lab ot-ant5: a Canal bought, the turn
 * ended at once, the rural district never landed). So a canal is opened only in the local player's turn; one that
 * completes in another player's turn opens at the next sweep, which runs as the local turn begins.
 */
function localTurnActive() {
  const p = safe(() => Players.get(state.localId >= 0 ? state.localId : GameContext.localPlayerID), null);
  return !p || safe(() => p.isTurnActive !== false, true);
}

/** Outside the local turn: say so once a turn, and leave the opening to the next sweep. */
function notThisTurn(loc) {
  if (localTurnActive()) return false;
  const k = `wait ${idx(loc)} ${safe(() => Game.turn, 0)}`;
  if (!state.told.has(k)) { state.told.add(k); log(`Canal at ${loc.x},${loc.y} finished outside your turn; it opens as your turn begins`); }
  return true;
}

async function openCanal(loc, owner) {
  const plot = idx(loc);
  if (state.busy.has(plot) || state.hold) return; // held: the next sweep opens it (see keeping the land look)
  if (notThisTurn(loc)) return;
  state.busy.add(plot);
  try {
    const canal = canalOn(loc);
    if (!canal || !canal.complete) return;
    const onRecord = loadOpen().some((e) => e.plot === plot);
    // Coast already: an open canal (the Canal building stays on the finished tile), or a flip that landed after its
    // wait ran out, which left a Coast tile with an urban Canal and no record; that one is taken up from here.
    const alreadyWater = terrainOf(loc) === "TERRAIN_COAST";
    if (alreadyWater && onRecord) return;
    if (state.saving || onRecord) return; // an open canal, land only while a save runs
    if (alreadyWater) log(`Canal at ${loc.x},${loc.y}: water already, no record; opened from here`);
    const shared = occupants(loc).some((o) => o.type !== canal.type && !isImprovement(o.type));
    if (shared || !isIsthmus(loc, ruleFor(canal.type))) {
      log(`Canal at ${loc.x},${loc.y} ${shared ? "shares its tile with other buildings" : "is not on a canal site"}; left as a building`);
      forget(plot); return;
    }
    const who = owner != null ? owner : canal.owner;
    const local = GameContext.localPlayerID;
    const cityId = safe(() => {
      const c = GameplayMap.getOwningCityFromXY(loc.x, loc.y);
      return c && c.id !== -1 ? c : null;
    }, null);
    // The retype clears the plot's cliff flags but leaves the rock faces drawn; remember which shores were cliffs
    // so the overlay can dress them as locks.
    const cliffSides = cliffSideIndexes(loc);
    const landType = alreadyWater ? "TERRAIN_FLAT" : terrainOf(loc);
    const age = canal.type === ONE_TILE_CANAL ? ONE_TILE : canal.type === "BUILDING_CANAL_MODERN" ? "AGE_MODERN"
      : canal.type === "BUILDING_CANAL_EXPLORATION" ? "AGE_EXPLORATION" : "AGE_ANTIQUITY";
    const flipped = alreadyWater || await flipToCoast(loc);
    if (!flipped) { log(`Canal at ${loc.x},${loc.y}: terrain did not change; left as a building`); return; }
    // On record the moment it is water. The rest of this is seconds of engine requests; a save that starts in that
    // time lands this canal with the others (wrapSaveGame) and the load knows it as a canal, not as open sea with
    // no record of its own.
    rememberOpen(plot, age, cliffSides, landType);
    // The Canal and its urban district go: an urban district draws a block of houses over the hex, which hides the
    // canal (run c14). The citizen the Canal housed comes back as a pending point and is placed on the
    // finished canal with the game's own expand order, which makes it a worked rural fishing tile (c23);
    // the invisible works building of the canal's age then adds its food and gold to the city natively.
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: canal.owner, LocalID: canal.id }));
    await sleep(300);
    const did = districtIdAt(loc);
    if (did) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "DISTRICT", Owner: did.owner, LocalID: did.id }));
    await sleep(1200);
    // Removing the district releases the plot; give it back to the city.
    if (cityId && safe(() => GameplayMap.getOwner(loc.x, loc.y), -1) !== who) {
      safe(() => Cities.get(cityId).purchasePlot({ x: loc.x, y: loc.y }));
      await sleep(1500);
    }
    forget(plot);
    await settleCanalTile(loc, cityId, who, canal.type);
    state.openedHere.add(plot); state.landMesh.add(plot);
    const drawn = drawOverlay(loc, age, cliffSides);
    const redrawn = redrawNeighbours(loc);
    log(`canal opened at ${loc.x},${loc.y} for player ${who}: ${terrainOf(loc)} district=${districtAt(loc) || "none"} owner=${safe(() => GameplayMap.getOwner(loc.x, loc.y))} overlay=${drawn} neighboursRedrawn=${redrawn}`);
  } finally { state.busy.delete(plot); }
}

// the look, in-session
//
// A retyped hex keeps its land mesh until the next load (the engine redraws it as water then). Until then the
// canal is drawn by script from shipped meshes (runs c11 to c13, 2026-09-25): one river channel piece per
// water side, meeting at the hex center, a stone quay with cranes along the first arm, and moored river boats.
// The model group lives for the session; after a reload the engine's own water and quay take over.

const ARM_ASSET = "TER_Decal_RiverPiece_Straight";
const BOATS_ASSET = "IMP_FishingBoat_River_I_W_O_E";
/**
 * Per age, several looks; a canal takes the one its plot number selects, so it keeps that look across reloads.
 * Each entry: whether the river-city house layout is drawn (with which attachment set), and the props placed along
 * the first arm as [asset, along, left, scale]. Runs c16, c17 and c19 (2026-09-25) covered the harbors, the wharf,
 * the shipyard and the layouts; the pier B and Modern pier pieces are siblings of pieces seen there.
 */
const AGE_LOOKS = {
  AGE_ANTIQUITY: [
    { layout: false, props: [["GEN_ANT_Harbor_HB", 0.2, 0.25, 0.6], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.5]] },
    { layout: false, props: [["GEN_ANT_Harbor_Pier_HB", 0.15, 0.22, 0.55]] },
    { layout: false, props: [["GEN_ANT_Harbor_Pier_B_HB", 0.15, 0.22, 0.55], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.45]] },
  ],
  AGE_EXPLORATION: [
    { layout: true, attachments: "_Attachments", props: [["MED_SPN_Wharf_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_Attachments", props: [["MID_ABB_Shipyard_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_Attachments", props: [["MED_SPN_Wharf_HB", 0.2, 0.25, 0.5], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.45]] },
  ],
  AGE_MODERN: [
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_Pier_HB", 0.15, 0.22, 0.55]] },
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_HB", 0.2, 0.25, 0.5], ["GEN_MOD_Harbor_Pier_B_HB", -0.15, -0.22, 0.45]] },
  ],
};
const overlays = new Map();

/** Screen angle of a ring direction: the arm piece points east at 0 and turns counter-clockwise on screen. */
function armAngle(ringIndex) { return (360 - 60 * ringIndex) % 360; }

/** Ring indexes of the hex's open ship-water sides. */
function waterSideIndexes(loc) {
  const out = [];
  RING.forEach((d, i) => { if (openWaterSide(loc, d)) out.push(i); });
  return out;
}

/** How far apart two ring directions are: 3 is straight across the hex, 1 is neighbouring sides. */
function ringGap(a, b) { const d = Math.abs(a - b) % 6; return Math.min(d, 6 - d); }

/** Ring indexes of opened canals beside the tile (queued ones are still land and get no arm until they open). */
function canalSideIndexes(loc) {
  const open = new Set(loadOpen().map((e) => e.plot));
  const out = [];
  RING.forEach((d, i) => { const n = neighborIn(loc, d); if (n && open.has(idx(n)) && isWater(n)) out.push(i); });
  return out;
}

/** The ways a ship can come in, as groups of ring indexes: each run of open water is one, each center another. */
function waysIn(loc, sides) {
  const water = RING.map((d, i) => sides.includes(i) && !!safe(() => isOpenWater(neighborIn(loc, d)), false));
  const groups = [];
  const start = water.every(Boolean) ? 0 : water.findIndex((w, i) => w && !water[(i + 5) % 6]);
  if (start >= 0) {
    let cur = null;
    for (let k = 0; k < 6; k++) {
      const i = (start + k) % 6;
      if (water[i]) { if (!cur) { cur = []; groups.push(cur); } cur.push(i); } else cur = null;
    }
  }
  for (const i of sides) if (!water[i]) groups.push([i]);
  return groups;
}

/**
 * The channel's arms. A canal is drawn as a channel between its shores, not as a spoke to every side: a tile with
 * water on five sides used to get five arms and read as a star. Now: one arm to each opened canal beside it, so a
 * run reads as one waterway and a Modern junction keeps its branches; a run's end adds the way in most nearly
 * opposite its canal; a single canal takes one way in from each of two different shores, as nearly opposite as the
 * hex allows.
 */
function channelSides(loc, water, links) {
  const beside = canalSideIndexes(loc).filter((i) => water.includes(i));
  const canal = links ? links.filter((i) => water.includes(i)) : beside;
  if (canal.length >= 2) return canal;
  const others = water.filter((i) => !beside.includes(i));
  if (!others.length) return canal;
  if (canal.length === 1) {
    const best = others.reduce((b, i) => (ringGap(i, canal[0]) > ringGap(b, canal[0]) ? i : b), others[0]);
    return [canal[0], best].sort((a, b) => a - b);
  }
  const groups = waysIn(loc, others);
  const pairs = [];
  if (groups.length >= 2) {
    for (let g = 0; g < groups.length; g++) for (let h = g + 1; h < groups.length; h++)
      for (const i of groups[g]) for (const j of groups[h]) pairs.push([i, j]);
  } else {
    // one continuous shore that holds two bodies of water (qualified by area, not by stretch): split by area
    for (let g = 0; g < others.length; g++) for (let h = g + 1; h < others.length; h++) {
      const a = areaOf(neighborIn(loc, RING[others[g]])), b = areaOf(neighborIn(loc, RING[others[h]]));
      if (a !== b) pairs.push([others[g], others[h]]);
    }
  }
  if (!pairs.length) {
    if (others.length <= 2) return others;
    for (let g = 0; g < others.length; g++)
      for (let h = g + 1; h < others.length; h++) pairs.push([others[g], others[h]]);
  }
  pairs.sort((p, q) => ringGap(q[0], q[1]) - ringGap(p[0], p[1]) || (p[0] + p[1]) - (q[0] + q[1]));
  return pairs[0].slice().sort((a, b) => a - b);
}

/** The opened canal tiles joined to this one, itself included: one waterway, drawn as one. */
function runOf(loc) {
  const open = new Set(loadOpen().map((e) => e.plot));
  const start = idx(loc);
  if (!open.has(start)) return [loc];
  const seen = new Set([start]); const out = [loc]; const queue = [loc];
  while (queue.length) {
    const c = queue.pop();
    for (const d of RING) {
      const n = neighborIn(c, d); if (!n) continue;
      const p = idx(n);
      if (seen.has(p) || !open.has(p) || !isWater(n)) continue;
      seen.add(p); out.push(n); queue.push(n);
    }
  }
  return out;
}

/**
 * The arms of every tile of a run, decided for the run as a whole. Each tile starts from its own channel (see
 * channelSides). Then the water around the run is grouped into shores - its tiles joined where two of them touch and
 * hold the same body of water - and a shore that no arm reaches gets one branch, from the one tile and side that
 * crowd the picture least: fewest arms, no cliff on that edge (a branch into a lake over a lock reads as a wall), the
 * widest angle to the tile's other arms. Without the branch a lake beside a canal looked cut off although ships cross
 * between them (the user's capture, c56: a lake touching both tiles of a two-tile cut, both of its sides pruned). Open
 * sea around a tile is one shore, which the channel already reaches, so it gets no spokes.
 * The one exception is a junction: where several canals meet on one tile (Modern), an arm runs to every one of them,
 * and such a tile takes a branch only while it has fewer than four arms. This is the drawing only; where canals may
 * be built is decided by isIsthmus.
 */
/**
 * Which neighbouring canal each tile of a run is drawn joined to: a tree grown from the tile where the most canals
 * meet. Every canal is joined to the run, and a crossroads reads as a cross; without it the arm tiles of a junction,
 * which touch each other too, were drawn joined all round and the crossing filled in as a blob. Drawing only: ships
 * cross between any two canal tiles that touch.
 */
function runLinks(run) {
  const plots = new Set(run.map(idx));
  const nb = new Map(run.map((t) => [idx(t), RING.map((d, i) => {
    const n = neighborIn(t, d); return n && plots.has(idx(n)) ? i : -1;
  }).filter((i) => i >= 0)]));
  const hub = run.slice().sort((a, b) => nb.get(idx(b)).length - nb.get(idx(a)).length || idx(a) - idx(b))[0];
  const links = new Map(run.map((t) => [idx(t), []]));
  const seen = new Set([idx(hub)]); const queue = [hub];
  while (queue.length) {
    const c = queue.shift();
    for (const i of nb.get(idx(c))) {
      const n = neighborIn(c, RING[i]); const p = idx(n);
      if (seen.has(p)) continue;
      seen.add(p); queue.push(n);
      links.get(idx(c)).push(i); links.get(p).push((i + 3) % 6);
    }
  }
  for (const a of links.values()) a.sort((x, y) => x - y);
  return links;
}

const MAX_ARMS_WITH_BRANCH = 4;
function runArms(run) {
  const open = new Map(loadOpen().map((e) => [e.plot, e]));
  const inRun = new Set(run.map(idx));
  const arms = new Map();
  const touch = [];
  const links = runLinks(run);
  for (const t of run) {
    const water = waterSideIndexes(t);
    arms.set(idx(t), channelSides(t, water, links.get(idx(t))));
    const cliffs = (open.get(idx(t)) || {}).cliffs || [];
    for (const i of water) {
      const n = neighborIn(t, RING[i]);
      if (n && !inRun.has(idx(n))) touch.push({ plot: idx(t), side: i, w: idx(n), cliff: cliffs.includes(i) });
    }
  }
  const wp = [...new Set(touch.map((x) => x.w))];
  const parent = new Map(wp.map((p) => [p, p]));
  const find = (p) => { while (parent.get(p) !== p) p = parent.get(p); return p; };
  for (let a = 0; a < wp.length; a++) for (let b = a + 1; b < wp.length; b++) {
    const A = locOf(wp[a]), B = locOf(wp[b]);
    if (isSettlementCentre(A) || isSettlementCentre(B)) continue;
    if (safe(() => GameplayMap.getPlotDistance(A.x, A.y, B.x, B.y), 9) !== 1 || areaOf(A) !== areaOf(B)) continue;
    parent.set(find(wp[a]), find(wp[b]));
  }
  const reached = new Set(touch.filter((x) => arms.get(x.plot).includes(x.side)).map((x) => find(x.w)));
  for (const shore of [...new Set(wp.map(find))]) {
    if (reached.has(shore)) continue;
    const key = (x) => {
      const a = arms.get(x.plot);
      const gap = a.length ? Math.min(...a.map((i) => ringGap(i, x.side))) : 3;
      return [a.length, x.cliff ? 1 : 0, -gap, x.plot, x.side];
    };
    // A tile never takes a branch that would give it a fifth arm: a junction's canals always meet on it (never
    // pruned, however many there are), but a branch on top of four would read as a star again.
    const room = (x) => find(x.w) === shore && arms.get(x.plot).length < MAX_ARMS_WITH_BRANCH;
    const best = touch.filter(room).sort((p, q) => {
      const a = key(p), b = key(q);
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
      return 0;
    })[0];
    if (best) { arms.set(best.plot, [...arms.get(best.plot), best.side].sort((a, b) => a - b)); reached.add(shore); }
  }
  return arms;
}

/**
 * The order the arms are drawn in: first the arm whose left-hand sector (the previous ring direction) is dry land,
 * so the props and the house layout, which sit to the left of the first arm, stand on a bank and never in water.
 * `water` is every water side of the tile, drawn or not.
 */
function orderSides(sides, water) {
  if (sides.length < 2) return sides;
  // "left" of an arm (alongArm's +y) is counter-clockwise on screen, which is the previous ring index
  // (armAngle turns counter-clockwise as the index falls); c32: the props sat on the next arm with +1.
  let k = sides.findIndex((i) => !(water || sides).includes((i + 5) % 6));
  if (k < 0) k = sides.findIndex((i) => !sides.includes((i + 5) % 6));
  return k <= 0 ? sides : sides.slice(k).concat(sides.slice(0, k));
}

/** The river-city layout whose corridor best fits the first two shores, to be rotated onto the first shore. */
function layoutFor(sides) {
  if (sides.length < 2) return "River_City_I_W_O_E";
  const diff = (sides[1] - sides[0] + 6) % 6;
  return diff === 3 ? "River_City_I_W_O_E" : diff === 4 ? "River_City_I_NW_O_E" : diff === 2 ? "River_City_I_SW_O_E" : "River_City_I_W_O_E";
}

/** Rotate an offset given in the first arm's frame (x along the arm, y to its left) into world offsets. */
function alongArm(angleDeg, x, y) {
  const a = angleDeg * Math.PI / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a), z: 0 };
}

/**
 * A lock where a channel meets a shore that was a cliff (the rock faces stay drawn after the retype, so the canal
 * is dressed as stepping down through them): a stone chamber with gates across the channel, a gatehouse on one
 * bank and a water wheel on the other. Pieces as [asset, along the arm, to its left, scale, angle offset].
 * Runs c29 and c30 (2026-09-25): further out than 0.42 the chamber vanishes into the cliff mesh. The looping
 * waterfall effect that stood past the lock (c34) is gone: from the game camera it read as a white spray standing up
 * out of the sea (lab c63).
 */
const LOCK_PIECES = [
  ["IMP_Saqiya_Canal_Decal_Straight_A", 0.42, 0, 1, 0],
  ["MED_CRT_Dockyard_Gate_HB", 0.42, 0.17, 0.5, 0],
  ["NEU_NOR_Gristmill_WaterWheel", 0.36, -0.16, 0.5, 0],
];

/**
 * The middle of the widest stretch of bank between a tile's arms, as a screen angle, and its width in ring steps (6
 * for a tile with one arm). A junction's quay stands there, clear of every channel.
 */
function widestBank(sides) {
  const s = sides.slice().sort((a, b) => a - b);
  if (s.length < 2) return { angle: (armAngle(s[0]) + 180) % 360, gap: 6 };
  let best = { angle: 0, gap: 0 };
  for (let k = 0; k < s.length; k++) {
    const a = s[k], gap = (s[(k + 1) % s.length] - a + 6) % 6 || 6;
    // ring indexes run clockwise on screen and angles counter-clockwise, so the bank after arm a lies below a's angle
    if (gap > best.gap) best = { angle: (armAngle(a) - 30 * gap + 360) % 360, gap };
  }
  return best;
}

/**
 * Locks, one per arm that meets natural water over a cliff. An edge between two canal tiles gets none: at a
 * crossroads every arm of the middle tile faced a cliff, and four chambers with their gatehouses and wheels closed
 * into a square stone pool (lab c63).
 */
function drawLocks(add, sides, cliffs, beside) {
  for (const i of sides) {
    if (!cliffs.includes(i) || beside.includes(i)) continue;
    const a = armAngle(i);
    for (const [asset, x, y, scale, rot] of LOCK_PIECES) add(asset, alongArm(a, x, y), scale, (a + rot) % 360);
  }
}

/**
 * The quay and harbour props. Along a channel they stand to the left of the first arm (see orderSides); a junction
 * takes the first one alone, set back on its widest bank and facing the water, since along an arm it stood in the
 * next channel.
 */
function drawProps(add, look, sides, a0) {
  if (sides.length < 3) {
    for (const [asset, x, y, scale] of look.props) add(asset, alongArm(a0, x, y), scale, a0);
    return;
  }
  const [asset, , , scale] = look.props[0];
  const bank = widestBank(sides);
  add(asset, alongArm(bank.angle, bank.gap >= 3 ? 0.3 : 0.24, 0), scale, (bank.angle + 90) % 360);
}

function drawOverlay(loc, age, cliffs) {
  const plot = idx(loc);
  if (overlays.has(plot) || typeof WorldUI === "undefined" || typeof PlacementMode === "undefined") return false;
  const water = waterSideIndexes(loc);
  if (!water.length) return false;
  const sides = orderSides(runArms(runOf(loc)).get(plot) || channelSides(loc, water), water);
  if (!sides.length) return false;
  // A one-tile canal takes the look of the age being played, so it is redrawn in each new age's style; an age
  // Canal keeps the look of the age it was dug in.
  const look = (AGE_LOOKS[age === ONE_TILE ? currentAge() : age] || AGE_LOOKS.AGE_ANTIQUITY)[plot % 3];
  const group = safe(() => WorldUI.createModelGroup("Canals_" + plot), null);
  if (!group) return false;
  const plotRef = { i: loc.x, j: loc.y };
  const add = (asset, off, scale, angle) => safe(() => group.addModelAtPlot(asset, plotRef, off || { x: 0, y: 0, z: 0 },
    { placement: PlacementMode.TERRAIN, followTerrain: true, needsShadows: true, scale, angle }));
  const a0 = armAngle(sides[0]);
  // A canal saved as Coast is drawn by the next load as shallow sea, where whatever stood on a bank would stand in the
  // water (the house layout read as a drowned street, lab c64). Canals are saved as land now (keepLandLook), so that
  // happens only to a canal from a save made before this version, until it is saved again. The cliff faces the locks
  // dress are drawn only until the next load, whatever the terrain.
  const landMesh = state.landMesh.has(plot);
  // The house layout is a corridor between two shores; a junction of three or more channels gets none, and nor does
  // a tile with water all round, where the houses would stand on no bank.
  if (landMesh && look.layout && sides.length <= 2 && water.length <= 2) {
    const L = layoutFor(sides); add(L, null, 1, a0);
    if (look.attachments) add(L + look.attachments, null, 1, a0);
    if (look.decal) add(L + look.decal, null, 1, a0);
  }
  for (const i of sides) add(ARM_ASSET, null, 1, armAngle(i));
  if (state.openedHere.has(plot) && cliffs && cliffs.length) drawLocks(add, sides, cliffs, canalSideIndexes(loc));
  drawProps(add, look, sides, a0);
  // Boats on the tiles that meet open water or a junction; a straight middle reach of a longer canal stays clear.
  if (sides.length !== 2 || (sides[1] - sides[0] + 6) % 6 !== 3 || plot % 2 === 0) add(BOATS_ASSET, null, 0.7, a0);
  overlays.set(plot, group);
  return true;
}

function clearOverlay(loc) {
  const g = overlays.get(idx(loc));
  if (g) { safe(() => g.clear()); safe(() => g.destroy()); overlays.delete(idx(loc)); }
}

/**
 * A canal that has just opened is water now: the rest of its run is redrawn, so the channels meet it and a branch
 * into a shore can move to whichever tile now suits it best.
 */
function redrawNeighbours(loc) {
  const open = new Map(loadOpen().map((e) => [e.plot, e]));
  let n = 0;
  for (const t of runOf(loc)) {
    const p = idx(t);
    if (p === idx(loc) || !open.has(p) || terrainOf(t) !== "TERRAIN_COAST") continue;
    clearOverlay(t);
    if (drawOverlay(t, open.get(p).age, open.get(p).cliffs)) n++;
  }
  return n;
}

/** The transit quota, for the local player's own move orders: a path through a canal already used this turn by
 * its quota of ships is not sent. (AI paths are decided natively and cannot be held.) */
function wrapUnitSend(oSend) {
  return function (unitId, type, args, ...rest) {
    try {
      if (state.enabled && !state.multiplayer && args && args.X != null && args.Y != null && (type === UnitOperationTypes.MOVE_TO || type === "UNITOPERATION_MOVE_TO")) {
        const turn = safe(() => Game.turn, -1);
        if (turn !== state.transitTurn) { state.transitTurn = turn; state.transits = new Map(); }
        const open = loadOpen();
        if (open.length) {
          const plots = safe(() => (Units.getPathTo(unitId, { x: args.X, y: args.Y }) || {}).plots || [], []);
          const from = safe(() => idx(Units.get(unitId).location), -1);
          const key = J(unitId);
          for (const e of open) {
            if (!plots.includes(e.plot) || e.plot === from) continue;
            const used = state.transits.get(e.plot) || new Set();
            const limit = TRANSITS_PER_TURN[e.age] == null ? Infinity : TRANSITS_PER_TURN[e.age];
            if (!used.has(key) && used.size >= limit) { log(`canal at ${locOf(e.plot).x},${locOf(e.plot).y} has taken its ${limit} ship(s) this turn; move not sent`); return false; }
            used.add(key); state.transits.set(e.plot, used);
          }
        }
      }
    } catch (_) { /* never block a move on a script error */ }
    return oSend(unitId, type, args, ...rest);
  };
}


/**
 * The finished canal tile: the citizen the Canal housed is placed on it with the city's own expand order (rural
 * district, fishing boats, a worker: c23), then the age's invisible works building is created there. If the
 * expand order does not offer the tile, a rural district is created directly and the citizen stays pending for the
 * player to place.
 */
// districts that belong to no city
//
// CREATE_ELEMENT makes a district for a player, and for a city only when the request names it as Parent. Without
// one the district has cityId null and is missing from the city's own district list. On a water canal nothing builds
// there, but the tile is land in every save, in the next age, and for good once Canals is turned off, and the first
// urban building the AI puts on it then crashes the game in native code (a player's save, runs hx-c1 to
// hx-c12: the same Bazaar commit crashed over a fishing boat, a farm and a bare tile, and went through once the
// district without a city was gone). Canals 1.2.1 and earlier made every AI canal's district that way.

/** The district on a tile, with the city that holds it (null when it holds none); null when there is no district. */
function districtHolder(loc) {
  return safe(() => {
    const d = Districts.getAtLocation(loc);
    if (!d) return null;
    const c = d.cityId;
    return { id: districtIdAt(loc), city: c && c.id != null && c.id !== -1 ? c : null };
  }, null);
}
function owningCity(loc) {
  return safe(() => {
    const c = GameplayMap.getOwningCityFromXY(loc.x, loc.y);
    return c && c.id !== -1 ? c : null;
  }, null);
}
async function destroyDistrict(loc) {
  const did = districtIdAt(loc);
  if (!did) return true;
  safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "DESTROY_ELEMENT", { Kind: "DISTRICT", Owner: did.owner, LocalID: did.id }));
  for (let i = 0; i < 30 && districtAt(loc) !== ""; i++) await sleep(100);
  return districtAt(loc) === "";
}
/**
 * A rural district on the tile, held by the city that owns it. One that lands without a city is taken off again: a
 * tile with no district is safe (it reads as plain owned land), one with a cityless district is not.
 */
async function createRuralDistrict(loc, cityId, owner) {
  const parent = cityId || owningCity(loc);
  if (!parent) { log(`canal at ${loc.x},${loc.y}: no city owns the tile; no district placed`); return false; }
  safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
    { Kind: "DISTRICT", Type: "DISTRICT_RURAL", Location: { x: loc.x, y: loc.y }, Parent: parent, Owner: owner }));
  for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100);
  const h = districtHolder(loc);
  if (!h) { log(`canal at ${loc.x},${loc.y}: the rural district did not land`); return false; }
  if (h.city) return true;
  const gone = await destroyDistrict(loc);
  log(`canal at ${loc.x},${loc.y}: the rural district landed without a city; ${gone ? "removed" : "COULD NOT be removed"}`);
  return false;
}
const CANAL_OF_AGE = { AGE_ANTIQUITY: "BUILDING_CANAL_ANTIQUITY", AGE_EXPLORATION: "BUILDING_CANAL_EXPLORATION", AGE_MODERN: "BUILDING_CANAL_MODERN", [ONE_TILE]: ONE_TILE_CANAL };
/**
 * Rebuild any opened canal's district that belongs to no city (every AI canal made by 1.2.1 or earlier): take it
 * off, give the plot back to its city (removing a district releases the plot), and settle the tile again with the
 * city as Parent. Only on a Coast tile, between saves; a save that starts mid-way waits on state.busy. Then any other
 * urban or rural district without a city, with its buildings (healDistrict).
 */
async function repairCitylessDistricts() {
  if (!state.enabled || state.multiplayer || state.saving || state.loading || state.hold || state.repairing) return;
  state.repairing = true;
  try {
    for (const e of loadOpen()) {
      if (state.saving || state.hold) return;
      const loc = locOf(e.plot); const h = districtHolder(loc);
      if (state.busy.has(e.plot) || terrainOf(loc) !== "TERRAIN_COAST") continue;
      if (h && h.city && canalOn(loc)) continue; // whole
      if (!localTurnActive()) return; // the requests would not land; the next turn's sweep comes back
      state.busy.add(e.plot);
      try {
        if (h && !h.city) await repairCanalTile(loc, e.age);
        else await healCanalTile(loc, e);
      } finally { state.busy.delete(e.plot); }
    }
    // Any other district without a city. A Canal ordered on a tile without an urban district got one made for it
    // (districtThenBuild), which 1.2.1 and earlier made without a city too; a build that never finished left it on
    // the land for good, off the pending list, and buildings later put there gave the city nothing (a player's save,
    // 2026-10-01). Pending tiles are read at every sweep. The rest of the map is read until one whole pass has gone
    // through cleanly, then never again for this game: from 1.2.2 the mod makes no district without a city, so only a
    // game begun with an older Canals has any, and the pass is recorded in the game (a save carries it).
    const open = new Set(loadOpen().map((e) => e.plot));
    const heal = async (plot) => {
      if (open.has(plot) || state.busy.has(plot)) return true;
      const loc = locOf(plot);
      if (!HEALED_DISTRICTS.includes(districtAt(loc))) return true;
      const h = districtHolder(loc);
      if (!h || h.city) return true;
      state.busy.add(plot);
      try { return await healDistrict(loc); } finally { state.busy.delete(plot); }
    };
    for (const plot of loadPending()) {
      if (state.saving || state.hold) return;
      await heal(plot);
    }
    if (mapChecked()) return;
    const W = safe(() => GameplayMap.getGridWidth(), 0), H = safe(() => GameplayMap.getGridHeight(), 0);
    let clean = W * H > 0;
    for (let plot = 0; plot < W * H; plot++) {
      if (state.saving || state.hold) return; // cut short: the next sweep reads the map again
      if (!(await heal(plot))) clean = false;
    }
    if (clean) {
      safe(() => Configuration.editGame().setValue(CHECKED_KEY, "1"));
      log("districts without a city: map checked, none left; not read again in this game");
    }
  } finally { state.repairing = false; }
}
const CHECKED_KEY = "Canals_DistrictsChecked_v1";
/** The whole map has been read once for districts without a city, in this game. */
function mapChecked() { return safe(() => String(Configuration.getGame().getValue(CHECKED_KEY)) === "1", false); }
// Districts a script can leave without a city on a canal site. A city centre or a wonder district is never touched.
const HEALED_DISTRICTS = ["DISTRICT_URBAN", "DISTRICT_RURAL"];
/**
 * Give a district without a city to the city that owns its tile, with what stands on it. A district cannot be moved
 * to a city: a second CREATE_ELEMENT naming the Parent changes nothing, and the district has no setter (hl2). Taking
 * the district off removes its buildings and releases the plot, so the plot is bought back for the city, the district
 * made again with the city as Parent, and every finished building and improvement made again on it:
 * they come back finished, held by the city, and their yields reach it (hl2: a Bank, a Kiln and Medieval Walls).
 * Anything still under construction there is not kept.
 */
async function healDistrict(loc) {
  const ownerOf = () => safe(() => GameplayMap.getOwner(loc.x, loc.y), -1);
  const owner = ownerOf(); const city = owningCity(loc); const type = districtAt(loc);
  const at = `${loc.x},${loc.y}`;
  // Only a major's tile held by one of its own cities: a Canal is built by majors alone, and an Independent Power
  // holds land with no city a script can see (see engine-closed.md).
  const major = owner >= 0 && safe(() => Players.get(owner).isMajor, false);
  if (!major) return true;
  if (!city || safe(() => Cities.get(city).owner, -1) !== owner) {
    if (!state.told.has("heal " + at)) { state.told.add("heal " + at); log(`${type} at ${at} belongs to no city and none of its owner's cities holds the tile; left as it is`); }
    return true;
  }
  const built = occupants(loc);
  // Newest age first: a building of this age put on a tile holding an older one of its kind replaces it (a player's
  // save, pv4: an Ironworks placed after the Stonecutter took its place; placed before it, both stood).
  const keep = built.filter((o) => o.complete).map((o) => o.type).sort((a, b) => ageRank(b) - ageRank(a));
  const dropped = built.filter((o) => !o.complete).map((o) => o.type);
  // The city builds on such a district (its lists offer the tile), but what it finishes there lands unfinished and
  // without a city, and the queue stalls on it at 100 % (hl5 control). The rebuild drops the queued item (hl5), so
  // the player's own orders for this tile are sent again once it is healed; an AI's city refuses a script's BUILD,
  // and its AI chooses again.
  // A building left unfinished there is ordered again too, at the end of the queue, if the city takes the order: put
  // back finished it would be a gift, and left on the map it never finishes (pv1: a Grocer).
  const mine = owner === GameContext.localPlayerID;
  const queued = mine ? queuedHere(city, loc) : [];
  if (mine) for (const t of dropped) if (!queued.some((q) => q.type === t)) queued.push({ type: t, at: -1 });
  if (!(await destroyDistrict(loc))) { log(`${type} at ${at} without a city COULD NOT be removed`); return false; }
  if (ownerOf() !== owner) {
    safe(() => Cities.get(city).purchasePlot({ x: loc.x, y: loc.y }));
    for (let i = 0; i < 40 && ownerOf() !== owner; i++) await sleep(100);
  }
  safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
    { Kind: "DISTRICT", Type: type, Location: { x: loc.x, y: loc.y }, Parent: city, Owner: owner }));
  for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100);
  const after = districtHolder(loc);
  if (!after || !after.city) {
    if (after) await destroyDistrict(loc);
    log(`${type} at ${at} rebuilt for its city: ${after ? "STILL NO CITY, removed" : "did not land"}; lost ${keep.join(",") || "nothing"}`);
    return false;
  }
  const place = async (types) => {
    for (const t of types) {
      safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
        { Kind: "CONSTRUCTIBLE", Type: t, Location: { x: loc.x, y: loc.y }, Owner: owner }));
      await sleep(300);
    }
    for (let i = 0; i < 30 && occupants(loc).length < keep.length; i++) await sleep(100);
  };
  await place(keep);
  const missing = () => keep.filter((t) => !occupants(loc).some((o) => o.type === t));
  if (missing().length) await place(missing()); // once more, for any the engine had not yet taken
  const back = occupants(loc).map((o) => o.type);
  const lost = missing();
  const requeued = [];
  for (const q of queued) if (await requeue(city, loc, q)) requeued.push(q.type);
  log(`${type} at ${at} without a city rebuilt for player ${owner}'s city: held by its city; ` +
    `${back.join(",") || "nothing on it"}${lost.length ? `; NOT put back: ${lost.join(",")}` : ""}` +
    `${dropped.length ? `; unfinished, not put back: ${dropped.join(",")}` : ""}` +
    `${queued.length ? `; queued again: ${requeued.join(",") || "none"} of ${queued.map((q) => q.type).join(",")}` : ""}`);
  return true;
}
const AGE_RANK = { AGE_ANTIQUITY: 1, AGE_EXPLORATION: 2, AGE_MODERN: 3 };
/** A constructible's age as a number (0 for one of no age). */
function ageRank(type) { return AGE_RANK[safe(() => String(GameInfo.Constructibles.lookup(type).Age), "")] || 0; }
/** A city's queue items on a tile: type and place in the queue. */
function queuedHere(city, loc) {
  return safe(() => (Cities.get(city).BuildQueue.getQueue() || []).map((q, at) => ({ q, at }))
    .filter(({ q }) => q.location && q.location.x === loc.x && q.location.y === loc.y && q.constructibleType != null)
    .map(({ q, at }) => ({ at, type: String(GameInfo.Constructibles.lookup(q.constructibleType).ConstructibleType) })),
  []);
}
/**
 * One queued item of a healed tile, ordered again. The old entry still stands in the queue after the rebuild and is
 * dropped unbuilt when its turn comes (hl5), and while it stands the engine takes no second order for the same
 * building (hl5-heal4). So it is cancelled (the queue's own RemoveAt), ordered again on the tile once the engine
 * takes the order (a district just made takes none for a moment, see districtThenBuild), and moved back to its
 * place. Progress already put into it is not carried over.
 */
async function requeue(city, loc, q) {
  const host = Game.CityOperations; const BUILD = CityOperationTypes.BUILD;
  const ok = (args) => !!safe(() => host.canStart(city, BUILD, args, false).Success, false);
  const send = (args) => ok(args) && (safe(() => host.sendRequest(city, BUILD, args)), true);
  const has = () => queuedHere(city, loc).find((x) => x.type === q.type);
  const stale = has();
  if (stale) {
    send({ InsertMode: CityOperationsParametersValues.RemoveAt, QueueLocation: stale.at });
    for (let i = 0; i < 20 && has(); i++) await sleep(100);
  }
  const ctype = safe(() => GameInfo.Constructibles.lookup(q.type).$index, -1);
  const order = { ConstructibleType: ctype, X: loc.x, Y: loc.y };
  for (let i = 0; i < 60 && !ok(order); i++) await sleep(100);
  if (!send(order)) {
    const why = safe(() => host.canStart(city, BUILD, order, false).FailureReasons, null);
    log(`${q.type} on ${loc.x},${loc.y} not ordered again: ${J(why) || "refused"}`);
    return false;
  }
  for (let i = 0; i < 20 && !has(); i++) await sleep(100);
  const now = has();
  if (!now) return false;
  const move = CityOperationsParametersValues.MoveTo;
  if (q.at >= 0 && now.at !== q.at)
    send({ InsertMode: move, QueueSourceLocation: now.at, QueueDestinationLocation: q.at });
  await sleep(200);
  return true;
}
/**
 * An open canal missing its district or its Canal building: an opening cut short (the turn ended part-way, so the
 * requests after it never landed), or anything else that took them off. The tile is settled again as an opening
 * leaves it: a rural district held by the city that owns the tile, the Canal of its own kind, the site marker. The
 * citizen an opening places is not given again: one cut short has already freed it, for the player to place.
 */
/** The tile's owner is a major civilization and one of its own cities holds the tile. */
function heldByOwnersCity(owner, city) {
  if (owner < 0 || !city || !safe(() => Players.get(owner).isMajor, false)) return false;
  return safe(() => Cities.get(city).owner, -1) === owner;
}
async function healCanalTile(loc, e) {
  const owner = safe(() => GameplayMap.getOwner(loc.x, loc.y), -1); const city = owningCity(loc);
  const at = `${loc.x},${loc.y}`;
  if (!heldByOwnersCity(owner, city)) {
    if (!state.told.has("heal " + at)) { state.told.add("heal " + at); log(`canal at ${at} is missing its district or Canal, and no city of its owner holds the tile; left as it is`); }
    return;
  }
  const missing = [districtAt(loc) === "" ? "district" : "", canalOn(loc) ? "" : "Canal"].filter(Boolean).join(" and ");
  await settleCanalTile(loc, city, owner, CANAL_OF_AGE[e.age] || CANAL_TYPES[0], { repair: true });
  const whole = !!(districtHolder(loc) || {}).city && !!canalOn(loc);
  log(`canal at ${at}: ${missing} missing; rebuilt for player ${owner}: ${whole ? "whole again" : "STILL INCOMPLETE"}; ` +
    `district=${districtAt(loc) || "none"} ${occupants(loc).map((o) => o.type).join(",") || "nothing on it"}`);
}

async function repairCanalTile(loc, age) {
  const ownerOf = () => safe(() => GameplayMap.getOwner(loc.x, loc.y), -1);
  const owner = ownerOf(); const city = owningCity(loc);
  const canalType = (canalOn(loc) || {}).type || CANAL_OF_AGE[age] || CANAL_TYPES[0];
  if (!(await destroyDistrict(loc))) { log(`canal at ${loc.x},${loc.y}: district without a city COULD NOT be removed`); return; }
  if (city && owner >= 0 && ownerOf() !== owner) {
    safe(() => Cities.get(city).purchasePlot({ x: loc.x, y: loc.y }));
    for (let i = 0; i < 40 && ownerOf() !== owner; i++) await sleep(100);
  }
  if (city && owner >= 0) await settleCanalTile(loc, city, owner, canalType, { repair: true });
  const after = districtHolder(loc);
  const held = after ? (after.city ? "held by its city" : "STILL NO CITY") : "no district";
  log(`canal at ${loc.x},${loc.y}: district without a city rebuilt for player ${owner}: ${held}; ` +
    `${occupants(loc).map((o) => o.type).join(",") || "nothing on it"}`);
}

async function settleCanalTile(loc, cityId, owner, canalType, opts) {
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  if (cityId && owner === local && !(opts && opts.repair)) {
    const city = safe(() => Cities.get(cityId), null);
    if (city) {
      safe(() => city.addRuralPopulation(1));
      await sleep(1500);
      const can = safe(() => Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false), null);
      const plots = (can && can.Plots) || [];
      const k = plots.indexOf(plot);
      if (k >= 0) {
        const args = { X: loc.x, Y: loc.y };
        if (can.ConstructibleTypes && can.ConstructibleTypes[k] != null)
          args.ConstructibleType = can.ConstructibleTypes[k];
        safe(() => Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, args));
        for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100);
      }
    }
  }
  if (districtAt(loc) === "" && !(await createRuralDistrict(loc, cityId, owner))) return;
  if (!occupants(loc).some((o) => o.type === canalType)) { safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT", { Kind: "CONSTRUCTIBLE", Type: canalType, Location: { x: loc.x, y: loc.y }, Owner: owner })); await sleep(1500); }
  // The Canal requires the site marker on its tile: the opened tile keeps one under its Canal, as the engine expects
  // of any tile that holds the building. Put last, so neither the fishing boat nor the Canal has to be placed over it.
  await markCanalTile(loc);
}

// keeping the land look across loads
//
// A load draws each hex from the terrain in the save, and a Coast hex comes out as open sea: the canal was gone
// from sight after every reload. So a canal is land in every save and Coast while the player plays; after a load it
// is turned to Coast again at once and drawn over the land mesh.
//
// The retype must land before a save starts, never during one: a canal retyped inside StartSaveRequest crashed the
// game on the save's worker thread (c71, c75: same stack), while the same canal already land when the autosave began
// saved cleanly (c74). Every save the UI makes goes through Network.saveGame, which is wrapped: the canals go to land,
// the save is sent once the map reads them as land, and they are Coast again on SaveComplete.
//
// The engine's own autosave comes about 120 ms after TurnEnd, too close for a retype. So while any canal is open the
// mod holds the engine's autosave (its frequency set out of reach, see holdEngineAutosave) and writes the autosave
// itself through the wrapped call at the start of the player's turn, on the player's own frequency and keep count.
// The canals are Coast through every AI turn, so AI ships use them. Nothing retypes a plot while state.hold is set,
// so a Canal finished in that window opens at the next sweep.

/** How long a save waits for a canal that is opening (the whole opening takes under ten seconds). */
const OPENING_WAIT_MS = 15000;

/** Retype the opened canals: "land" turns each Coast one back to the terrain it was cut from, "coast" the reverse. */
function retypeCanals(to) {
  const changed = [];
  try {
    withBlock(() => {
      for (const e of loadOpen()) {
        const loc = locOf(e.plot); const now = terrainOf(loc);
        if ((to === "land") !== (now === "TERRAIN_COAST")) continue;
        const want = to === "land" ? (e.land || "TERRAIN_FLAT") : "TERRAIN_COAST";
        const t = safe(() => GameInfo.Terrains.lookup(want).$index, -1);
        if (t < 0) continue;
        WorldBuilder.MapPlots.setTerrain(t, loc); changed.push(e.plot);
      }
    });
  } catch (err) { log("retype to " + to + " threw " + err); }
  return changed;
}

const readsLand = () => loadOpen().every((e) => terrainOf(locOf(e.plot)) !== "TERRAIN_COAST");

/** Turn the canals to land ahead of a save and hold every retype until they are Coast again. */
function landAhead(why) {
  if (!state.enabled || state.multiplayer) return 0;
  state.hold = true;
  const n = state.saving ? 0 : retypeCanals("land").length;
  if (n) log(`${why}: ${n} canal tile(s) to land ahead of the save`);
  return n;
}

/** The hold is over: canals back to Coast (never while a save runs or is about to, nor once the age is over). */
function coastAgain() {
  if (state.saving || state.loading || state.pendingSave) return [];
  if (ageIsOver()) { state.hold = true; retypeCanals("land"); return []; }
  state.hold = false;
  return retypeCanals("coast");
}

// The next age is built from the map as this one leaves it. The transition is a save of its own
// (SaveFileTypes.GAME_TRANSITION), and the new age's map script recomputes the water bodies from the terrain it
// inherits (TerrainBuilder.storeWaterData, base-standard/scripts/age-transition-post-load.js). A canal still Coast
// at that point would come into the new age as open sea. So once the age is over the canals turn to land and stay
// land; the new age loads them as land, like any save, and they turn Coast again after that load. "One more turn"
// (an extended game) is ordinary play: the canals are water again at the next turn start.

/** The age has ended and play does not go on past it. */
function ageIsOver() {
  const m = safe(() => Game.AgeProgressManager, null);
  if (m && safe(() => m.isExtendedGame, false)) return false;
  return state.ageEnded || !!(m && safe(() => m.isAgeOver, false));
}
/** GameAgeEnded, and again on BeforeAgeTransition: land the canals now (a retype never runs during a save). */
function onAgeEnded() {
  if (!state.enabled || state.multiplayer) return;
  state.ageEnded = true;
  if (!loadOpen().length) return;
  const n = landAhead("the age is over");
  if (!n && !readsLand()) log("the age is over during a save; the canals turn to land when it completes");
}

function onSaveStart() {
  if (!state.enabled || state.multiplayer) return;
  state.saving = true; state.hold = true;
  if (!readsLand()) log("save started with a canal still Coast: it reloads as open water");
}
function onSaveDone() {
  if (!state.enabled || state.multiplayer) return;
  state.saving = false; state.pendingSave = false;
  coastAgain();
  if (state.prune) setTimeout(pruneAutosave, 500);
  if (state.reloadFrom) {
    const name = state.reloadFrom; state.reloadFrom = null;
    setTimeout(() => {
      const ok = safe(() => Network.loadGame(autosaveParams(name), ServerType.SERVER_TYPE_NONE), false);
      log(`reload from ${name}: ${ok ? "sent" : "refused"}`);
    }, 1000);
  }
}

/** Network.saveGame, but the canals are land on the map before the save is sent. */
function wrapSaveGame(host) {
  const original = host.saveGame;
  host.saveGame = function (params) {
    if (!state.enabled || state.multiplayer || state.saving || !loadOpen().length) return original.call(host, params);
    state.pendingSave = true;
    const t0 = Date.now(); let landed = false;
    const send = () => {
      // A canal opening now (its tile water and on record, its district, boat and building still to come) finishes
      // first: a save taken half-way through held the tile bare, and it reloaded as water with no Canal on it (fx4).
      if (state.busy.size && Date.now() - t0 < OPENING_WAIT_MS) { setTimeout(send, 100); return; }
      if (!landed) { landed = true; landAhead("save"); }
      if (!readsLand() && Date.now() - t0 < OPENING_WAIT_MS + 3000) { setTimeout(send, 50); return; }
      // one more beat after the read, so the retype is settled before the save thread starts
      setTimeout(() => {
        const ok = safe(() => original.call(host, params), false);
        if (!ok) { log("save refused by the engine"); state.pendingSave = false; coastAgain(); }
      }, 100);
    };
    send();
    return true; // the save screen then waits for SaveComplete, as it does for any save
  };
  return original;
}

// The engine's autosave frequency is a user setting (UserOptions.txt). While a canal is open it is stored as
// AUTOSAVE_HELD + the player's own value: out of reach, so the engine writes no autosave (c86: none at 1000), and the
// player's value can always be read back. ui/canals-shell.js puts the player's value back whenever the main menu
// loads, so it never outlives the game, a crash included.
const AUTOSAVE_HELD = 1000;

function user() { return safe(() => Configuration.getUser(), null); }
function playerAutosaveEvery() {
  const f = safe(() => user().autoSaveFrequency, 1);
  return Math.max(1, f >= AUTOSAVE_HELD ? f - AUTOSAVE_HELD : f);
}

/** While a canal is open, keep the engine's own autosave from being written (re-applied if the player changes it). */
function holdEngineAutosave() {
  if (!state.enabled || state.multiplayer || !loadOpen().length) return;
  const u = user(); const f = safe(() => u.autoSaveFrequency, AUTOSAVE_HELD);
  if (f >= AUTOSAVE_HELD) return;
  safe(() => u.setAutoSaveFrequency(AUTOSAVE_HELD + Math.max(1, f)));
  log(`autosave: every ${Math.max(1, f)} turn(s), written by the mod with the canals as land`);
}

// The Options screen reads the frequency straight from the user setting, so while it is held the slider showed the
// player's value plus 1000. The option is built when the screen first opens (core/ui/options/options.js adds it
// through Options.addOption); it is wrapped as it is added, so it shows the player's own value, and a value the
// player picks there is their new setting, held again at once.
const AUTOSAVE_OPTION = "option-autosavefrequency";
function wrapAutosaveOption(info) {
  if (!info || info.canalsWrapped) return;
  const init = info.initListener; const update = info.updateListener;
  info.initListener = (o) => {
    if (init) init(o);
    const f = safe(() => user().autoSaveFrequency, 0);
    if (f >= AUTOSAVE_HELD) { o.currentValue = f - AUTOSAVE_HELD; o.formattedValue = `${f - AUTOSAVE_HELD}`; }
  };
  info.updateListener = (o, value) => { if (update) update(o, value); holdEngineAutosave(); };
  info.canalsWrapped = true;
}
async function wrapOptionsScreen() {
  try {
    const { Options } = await import("/core/ui/options/model-options.js");
    if (!Options || typeof Options.addOption !== "function") { log("Options model not found; the Options screen shows the held frequency"); return; }
    const add = Options.addOption;
    Options.addOption = function (info) {
      if (info && info.id === AUTOSAVE_OPTION) wrapAutosaveOption(info);
      return add.call(this, info);
    };
    if (state.originals) state.originals.addOption = { host: Options, add };
    const live = safe(() => Options.data.get(AUTOSAVE_OPTION), null);
    if (live) { wrapAutosaveOption(live); live.initListener(live); }
  } catch (e) { log("Options screen not wrapped: " + e); }
}

/** The engine's own name for an autosave, AutoSave_<age>_<turn> (AutoSave_01_0072: Exploration, turn 72), so the
 * mod's autosaves carry on the game's series in the Autosaves tab and under Continue. */
function autosaveName(turn) {
  const age = safe(() => GameInfo.Ages.lookup(Game.age).ChronologyIndex, 0);
  return `AutoSave_${String(age).padStart(2, "0")}_${String(turn).padStart(4, "0")}`;
}
function autosaveParams(name) {
  return { Location: SaveLocations.LOCAL_STORAGE, LocationCategories: SaveLocationCategories.AUTOSAVE,
    Type: SaveTypes.SINGLE_PLAYER, ContentType: SaveFileTypes.GAME_STATE, FileName: name };
}

/** The player's turn has begun: write the autosave the engine would have written, canals as land. The one that
 * falls past the player's keep count is deleted once the new one is written, as the engine does with its own. */
function writeAutosave() {
  if (!state.enabled || state.multiplayer || !loadOpen().length) return;
  if (safe(() => user().autoSaveFrequency, 0) < AUTOSAVE_HELD) return; // not held: the engine wrote its own
  const turn = safe(() => Game.turn, 0); const every = playerAutosaveEvery();
  if (turn % every !== 0) return;
  const keep = Math.max(1, safe(() => user().autoSaveKeepCount, 10));
  const name = autosaveName(turn);
  state.prune = turn - keep * every > 0 ? autosaveName(turn - keep * every) : null;
  const ok = safe(() => Network.saveGame({ ...autosaveParams(name), Overwrite: true }), false);
  if (!ok) state.prune = null;
  log(`autosave: turn ${turn} as ${name} ${ok ? "sent" : "refused"}`);
}

/** After the mod's autosave is written: delete the one it pushed past the keep count. */
function pruneAutosave() {
  const name = state.prune; state.prune = null;
  if (!name) return;
  const ok = safe(() => Network.deleteGame(autosaveParams(name)), false);
  log(`autosave: ${name} ${ok ? "deleted" : "not deleted"} (keep count)`);
}

// The local player as the game was loaded: GameContext.localPlayerID does not read it while Autoplay runs (c76).
function isLocal(d) { return !!d && (d.player ?? d.Player) === state.localId; }
function onTurnDeactivated(d) { if (isLocal(d)) holdEngineAutosave(); }
function onTurnActivated(d) {
  if (!isLocal(d)) return;
  holdEngineAutosave();
  writeAutosave();
  setTimeout(sweep, SETTLE_MS);
  setTimeout(syncSites, 3000); // after the autosave and the sweep
}

// Loading an autosave makes the engine save again as the game starts (c78; c79: StartSaveRequest 55 ms after
// GameStarted, at the Begin Game press). So the canals stay as loaded until the game has started and no save has run
// for a few seconds, then turn Coast; a retype during that load-time save would be the crash above.
const LOAD_QUIET_MS = 3000;

/** After a load: canals that came in as land are drawn as land this session, and turn Coast once the game is up. */
function keepLandLook() {
  state.loading = true; state.hold = true;
  // A save that holds a canal as Coast was written by Canals 1.0.0, which kept canals as water in saves. The load
  // has already drawn it as open sea, and no retype redraws a hex in play (c99), but turned to land at once it is
  // land in every save from here on, the one the game writes as it starts included; see offerReload.
  const stale = retypeCanals("land");
  if (stale.length) log(`load: ${stale.length} canal tile(s) saved as Coast (an older save), turned to land`);
  for (const e of loadOpen()) if (!stale.includes(e.plot) && terrainOf(locOf(e.plot)) !== "TERRAIN_COAST") state.landMesh.add(e.plot);
  state.staleLoad = stale;
  const t0 = Date.now(); let quietSince = 0;
  const up = () => UI.getGameLoadingState() === UIGameLoadingState.GameStarted;
  const started = () => safe(up, Date.now() - t0 > 15000);
  const poll = () => {
    if (!started() || state.saving) { quietSince = 0; setTimeout(poll, 250); return; }
    if (!quietSince) quietSince = Date.now();
    if (Date.now() - quietSince < LOAD_QUIET_MS) { setTimeout(poll, 250); return; }
    state.loading = false;
    const n = coastAgain().length;
    if (n) log(`load: ${n} canal tile(s) back to Coast, drawn over the land`);
    setTimeout(sweep, 1000); // the overlay is drawn on tiles that read Coast, a beat after the retype
    setTimeout(syncSites, 2000); // a game begun with the mod, or with a new site since the save: mark it now
  };
  poll();
}

/** Re-check every remembered site and every complete Canal on the map (missed events, reloads, AI canals). */
function sweep() {
  if (!state.enabled || state.multiplayer || state.saving || state.loading) return;
  const restored = coastAgain().length;
  if (restored) log(`turn start: ${restored} canal tile(s) back to Coast`);
  const opened = new Set(loadOpen().map((e) => e.plot));
  for (const e of loadOpen()) { const loc = locOf(e.plot); if (terrainOf(loc) === "TERRAIN_COAST") drawOverlay(loc, e.age, e.cliffs); }
  const seen = new Set();
  for (const plot of loadPending()) {
    const loc = locOf(plot); seen.add(plot);
    const c = canalOn(loc);
    if (!c) { if (terrainOf(loc) === "TERRAIN_COAST" || districtAt(loc) === "") forget(plot); continue; }
    if (c.complete) openCanal(loc, c.owner);
  }
  const W = safe(() => GameplayMap.getGridWidth(), 0), H = safe(() => GameplayMap.getGridHeight(), 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const loc = { x, y }; const plot = idx(loc);
    if (seen.has(plot)) continue;
    const c = canalOn(loc);
    if (!c || !c.complete || opened.has(plot) || terrainOf(loc) === "TERRAIN_COAST") continue;
    if (isIsthmus(loc, ruleFor(c.type))) openCanal(loc, c.owner);
  }
  repairCitylessDistricts();
}

function onBuildCompleted(data) {
  if (!state.enabled || state.multiplayer || !data || !data.location) return;
  const def = safe(() => GameInfo.Constructibles.lookup(data.constructibleType), null);
  if (!def || !CANAL_TYPES.includes(String(def.ConstructibleType))) return;
  const loc = { x: data.location.x, y: data.location.y };
  const owner = data.constructible ? data.constructible.owner : undefined;
  setTimeout(() => openCanal(loc, owner), SETTLE_MS);
}

// placement and commit

function plotOf(args) { return args && args.X != null && args.Y != null ? { x: args.X, y: args.Y } : null; }

/**
 * The city's land tiles that qualify, whether or not the engine offered them. `anyUnits` keeps a tile a unit stands
 * on (the site marks: a unit passing through must not unmark a site for a turn).
 */
function eligiblePlots(cityID, anyUnits = false) {
  const city = safe(() => Cities.get(cityID), null);
  if (!city) return [];
  const out = [];
  const centre = safe(() => city.location, null);
  for (const p of safe(() => city.getPurchasedPlots() || [], [])) {
    const loc = locOf(p);
    // Only tiles the city can build on: within its ring (a purchased tile 12 plots out is refused).
    if (centre && safe(() => GameplayMap.getPlotDistance(centre.x, centre.y, loc.x, loc.y), 99) > BUILD_RADIUS)
      continue;
    if (!isIsthmus(loc) || hasResource(loc) || isParkland(loc)) continue;
    if (unfinishedCanal(cityID, loc)) { out.push(p); continue; }
    // never a tile that holds buildings: the canal removes whatever stands on it
    const d = districtAt(loc);
    if (d !== "" && d !== "DISTRICT_RURAL") continue;
    if (occupants(loc).some((o) => !isImprovement(o.type))) continue;
    if (canalOn(loc) || loadPending().includes(p)) continue;
    if (!anyUnits && safe(() => (MapUnits.getUnits(loc.x, loc.y) || []).length, 0) > 0) continue;
    out.push(p);
  }
  return out;
}

/**
 * A Canal begun on this tile and taken out of the queue before it was finished. The engine leaves it on the map with
 * the production put into it, and an order for the same Canal on the same tile takes it up again, progress and all
 * (rs1). The tile now holds a district, a building and a remembered site, so the checks for a fresh site would never
 * offer it again.
 */
function unfinishedCanal(cityID, loc) {
  const c = canalOn(loc);
  if (!c || c.complete || c.owner !== cityOwner(cityID)) return false;
  if (!isOfferedCanal(safe(() => GameInfo.Constructibles.lookup(c.type), null))) return false;
  return !queuedHere(cityID, loc).some((q) => q.type === c.type);
}

/**
 * The engine's verdict on whether a Canal may be had at all (locked, already queued, too little gold), as opposed to
 * where. Only a plain "no suitable location" is ours to override, because that is the engine not seeing the canal
 * sites. Anything else is kept, including an unlock the player has not earned: a refusal for a locked building
 * carries no reasons at all (engine-closed.md, 2026-09-24), so a missing reason must not read as consent.
 */
function engineSaysNo(res) {
  if (!res) return true;
  if (res.Success) return false;
  if (res.NeededUnlock != null && res.NeededUnlock !== -1) return true;
  const reasons = res.FailureReasons || [];
  const locationOnly = res.NoSuitableLocation === true
    || (reasons.length > 0 && reasons.every((r) => String(r) === "LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"));
  return !locationOnly;
}

/** The Canal of the age being played. The other two stay in the database so a canal dug in an earlier age is still
 * recognised on the map, but they are never offered. */
function canalDef(type) {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (!d) continue;
    if (d.$index === type || safe(() => GameInfo.Types.lookup(t).Hash, null) === type) return d;
  }
  return null;
}
function isThisAgesCanal(d) {
  const age = safe(() => String(GameInfo.Ages.lookup(Game.age).AgeType), "");
  return !!d && (!age || !d.Age || String(d.Age) === age);
}
/** The Canal the player and the AI may have now: the one-tile Canal in that mode, else the age's own. */
function isOfferedCanal(d) {
  if (!d) return false;
  const oneTile = String(d.ConstructibleType) === ONE_TILE_CANAL;
  return oneTileMode() ? oneTile : !oneTile && isThisAgesCanal(d);
}

/** The tech that unlocks this Canal in the age being played (data/canals-<age>.xml), or null. */
function unlockNode(def) {
  return safe(() => {
    const row = GameInfo.ProgressionTreeNodeUnlocks.find((r) => String(r.TargetType) === String(def.ConstructibleType));
    return row ? String(row.ProgressionTreeNodeType) : null;
  }, null);
}

/**
 * A Canal the engine keeps locked although its owner has researched its tech. An unlock fires when its tech is
 * researched and never afterwards (engine-closed.md), so in a game the mod was added to after that point, the
 * engine keeps this age's Canal locked until the age ends; the tech is honoured by the mod instead. The mod cannot
 * unlock a building (no script call does), so such a Canal is sold for gold and placed by the mod: production
 * cannot build a locked building.
 */
function unlockedByMod(pid, def, res) {
  if (!def || !res || res.Success || res.AlreadyExists || res.InQueue || res.InsufficientFunds) return false;
  const node = unlockNode(def);
  if (!node) return false;
  const needed = res.NeededUnlock != null && res.NeededUnlock !== -1
    ? safe(() => String(GameInfo.ProgressionTreeNodes.lookup(res.NeededUnlock).ProgressionTreeNodeType), null) : null;
  if (needed && needed !== node) return false;
  // On a save the mod was added to, the refusal names no tech and gives no reason at all: {Success: false} (c101).
  // Callers pass only this age's Canal, so a refusal with no reason is the missing unlock, not the wrong age.
  if (!needed && !res.Locked && (res.FailureReasons || []).length) return false;
  return !!safe(() => Players.get(pid).Techs.isNodeUnlocked(node), false);
}
function cityOwner(cityID) { return safe(() => Cities.get(cityID).owner, -1); }

/** The engine's gold price for the building in this settlement, and whether its owner is short of it. */
function modPrice(cityID, def) {
  const price = () => Cities.get(cityID).Gold.getBuildingPurchaseCost(YieldTypes.YIELD_GOLD, def.ConstructibleType);
  const cost = Math.round(safe(price, 0));
  const gold = safe(() => Players.get(cityOwner(cityID)).Treasury.goldBalance, 0);
  return { cost, short: !(cost > 0) || gold < cost };
}

/**
 * Wraps a canStart that places a building: Game.CityOperations BUILD (production) or Game.CityCommands PURCHASE
 * (gold; a town's only way to get a building). For a Canal the offered plots are the canal sites and nothing else,
 * the engine's own urban-expansion plots included (c36: a town's purchase offered three plain tiles beside it
 * and refused the site).
 */
/**
 * No other building may stand on an opened canal. The tile is a worked rural tile, so the engine offered it to every
 * building as a place to expand onto, and a player built a Garden on a canal (report, 2026-09-28). It is taken out of
 * every other building's lists, and a request aimed at it is refused.
 */
function keepOffCanals(res, args) {
  const open = new Set(loadOpen().map((e) => e.plot));
  if (!open.size || !res || typeof res !== "object") return res;
  const loc = plotOf(args);
  if (loc) return open.has(idx(loc)) ? { ...res, Success: false, FailureReasons: ["LOC_CANAL_TILE_TAKEN"] } : res;
  const strip = (a) => (Array.isArray(a) ? a.filter((p) => !open.has(p)) : a);
  return { ...res, Plots: strip(res.Plots), ExpandUrbanPlots: strip(res.ExpandUrbanPlots) };
}

function wrapCanStart(oCan, placeType, purchase) {
  return function (cityID, type, args, ...rest) {
    const res = oCan(cityID, type, args, ...rest);
    if (!state.enabled || type !== placeType || !args) return res;
    const def = canalDef(args.ConstructibleType);
    if (!def) return args.ConstructibleType != null ? keepOffCanals(res, args) : res;
    // Not the mode's Canal: refused outright. The engine alone would offer the one-tile Canal outside its mode, since
    // it has no age and no unlock (and refuse it only for want of a marked site, which this wrapper overrides).
    if (!isOfferedCanal(def)) return { ...res, Success: false, Plots: [], ExpandUrbanPlots: [], FailureReasons: ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
    if (state.multiplayer) return { ...res, Success: false, Plots: [], ExpandUrbanPlots: [], FailureReasons: ["LOC_CANAL_MULTIPLAYER"] };
    const loc = plotOf(args);
    if (loc) {
      if (!isIsthmus(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_NOT_ISTHMUS"] };
      if (hasResource(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_RESOURCE"] };
      if (isParkland(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_PARKLAND"] };
    }
    const general = loc ? oCan(cityID, type, { ConstructibleType: args.ConstructibleType }, ...rest) : res;
    let sold = null;
    if (engineSaysNo(general)) {
      if (!purchase || !unlockedByMod(cityOwner(cityID), def, general))
        return { ...general, Plots: [], ExpandUrbanPlots: [] };
      sold = modPrice(cityID, def);
    }
    // a Canal the mod sells itself (see unlockedByMod) reads as unlocked, priced, and short of gold when it is
    const open = sold ? { Locked: false, NeededUnlock: -1, Cost: sold.cost, InsufficientFunds: sold.short } : {};
    if (loc) {
      if (sold && sold.short) return { ...res, ...open, Success: false, FailureReasons: ["LOC_CITY_PURCHASE_INSUFFICIENT_FUNDS"] };
      return { ...res, ...open, Success: true, FailureReasons: [] };
    }
    const plots = eligiblePlots(cityID);
    const ok = plots.length > 0 && !(sold && sold.short);
    return { ...res, ...open, Plots: plots, ExpandUrbanPlots: [], MountainPlots: [], Success: ok, FailureReasons: plots.length ? [] : ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
  };
}

/**
 * The production and purchase lists are not built from canStart but from canStartQuery, and an entry whose result
 * says "no suitable location" is dropped from the list. The engine judges a Canal by its own rule and refuses it
 * wherever it sees no urban plot to expand onto, so in a town the row never appeared at all although the mod's own
 * canStart offered the site (c41 and c42). Give the Canal's entry the mod's verdict.
 */
function wrapCanStartQuery(oQuery, host, placeType) {
  return function (cityID, opType, queryType, ...rest) {
    const res = oQuery(cityID, opType, queryType, ...rest);
    const constructibles = safe(() => CityQueryType.Constructible, null);
    if (!state.enabled || opType !== placeType || !Array.isArray(res)) return res;
    if (constructibles == null || queryType !== constructibles) return res;
    for (const t of CANAL_TYPES) {
      const d = safe(() => GameInfo.Constructibles.lookup(t), null);
      if (!d) continue;
      if (!isOfferedCanal(d)) {
        // the other mode's Canal is never listed
        const k = res.findIndex((e) => e && e.index === d.$index);
        if (k >= 0) res.splice(k, 1);
        continue;
      }
      const verdict = safe(() => host.canStart(cityID, placeType, { ConstructibleType: d.$index }, false), null);
      if (!verdict) continue;
      const entry = res.find((e) => e && e.index === d.$index);
      if (entry) entry.result = verdict;
      // short of gold still lists it, greyed with its price, as the game lists any building it cannot afford
      else if (verdict.Success || (verdict.InsufficientFunds && (verdict.Plots || []).length))
        res.push({ index: d.$index, result: verdict });
    }
    return res;
  };
}

/** Whether the city's build queue holds a Canal of this type (given as its index or its type hash). */
function inQueue(cityID, ctype) {
  const def = canalDef(ctype);
  if (!def) return false;
  const hash = safe(() => GameInfo.Types.lookup(def.ConstructibleType).Hash, null);
  const items = safe(() => Cities.get(cityID).BuildQueue.getQueue() || [], []);
  return items.some((i) => [i.constructibleType, i.type].some((t) => t != null && (t === def.$index || t === hash)));
}

/**
 * A Canal BUILD or PURCHASE on a tile without an urban district: create one, then forward; undo the district on
 * refusal. A purchased Canal lands complete and the engine sends no completion event for it (c36), so the
 * canal is opened here.
 */
async function districtThenBuild(cityID, loc, ctype, forward, path) {
  const soldFor = path.soldFor;
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  const hadDistrict = districtAt(loc) === "DISTRICT_URBAN";
  const engineAccepts = () => safe(() => {
    const r = path.oCan.call(path.host, cityID, path.type, { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false);
    return !!(r && r.Success);
  }, false);
  if (!hadDistrict) {
    for (const o of occupants(loc)) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
    // Parent ties the district to the city; without it the district belongs to no city (see districtHolder).
    safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT",
      { Kind: "DISTRICT", Type: "DISTRICT_URBAN", Location: { x: loc.x, y: loc.y }, Parent: cityID, Owner: local }));
    for (let k = 0; k < 20 && districtAt(loc) !== "DISTRICT_URBAN"; k++) await sleep(100);
    if (districtAt(loc) !== "DISTRICT_URBAN") { log(`no urban district could be created at ${loc.x},${loc.y}; build not sent`); return; }
    if (!(districtHolder(loc) || {}).city) {
      await destroyDistrict(loc);
      log(`the urban district at ${loc.x},${loc.y} landed without a city; removed, build not sent`);
      return;
    }
  }
  // the engine takes a Canal only on a marked site (data/canals-sites.xml); a Canal the mod sells itself needs none
  if (soldFor == null && !await markSite(loc, markerFor((canalDef(ctype) || {}).ConstructibleType)))
    log(`the site marker did not land at ${loc.x},${loc.y}`);
  // The engine needs a moment before a new district counts as a site (a BUILD sent 200 ms after the
  // district landed was dropped; one sent 3 s later was taken). Wait for its own per-plot verdict.
  // (A Canal the mod sells itself is placed by the mod, not the engine, so there is no verdict to wait for.)
  if (soldFor == null) {
    for (let k = 0; k < 50 && !engineAccepts(); k++) await sleep(100);
    if (!engineAccepts()) log(`engine verdict on the Canal at ${loc.x},${loc.y}: ${J(safe(() => path.oCan.call(path.host, cityID, path.type, { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false), null))}`);
  }
  remember(plot);
  forward();
  const t0 = Date.now();
  while (Date.now() - t0 < BUILD_LAND_MS) {
    await sleep(100);
    const c = canalOn(loc);
    // a production order goes into the queue and reaches the map only later (s1): it is taken all the same
    if (!c && !path.purchase && inQueue(cityID, ctype)) { log(`Canal queued at ${loc.x},${loc.y}`); return; }
    if (!c) continue;
    if (soldFor != null) {
      safe(() => Players.grantYield(local, YieldTypes.YIELD_GOLD, -soldFor));
      log(`Canal sold by the mod at ${loc.x},${loc.y} for ${soldFor} gold (its tech was researched before the mod was added)`);
    }
    log(`Canal ${path.purchase ? "bought" : "queued"} at ${loc.x},${loc.y}`);
    if (path.purchase && c.complete) setTimeout(() => openCanal(loc, local), SETTLE_MS);
    return;
  }
  log(`the engine did not take the Canal at ${loc.x},${loc.y}; putting the tile back`);
  forget(plot);
  if (plot in loadSites() && !aiSites().has(plot)) await unmarkSite(loc);
  if (!hadDistrict) {
    const did = districtIdAt(loc);
    if (did) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "DISTRICT", Owner: did.owner, LocalID: did.id }));
    // Removing the district released the plot; buy it back for the city.
    await sleep(1000);
    if (safe(() => GameplayMap.getOwner(loc.x, loc.y), -1) !== local)
      safe(() => Cities.get(cityID).purchasePlot({ x: loc.x, y: loc.y }));
  }
}

function wrapSendRequest(oSend, path) {
  return function (cityID, type, args, ...rest) {
    const other = args && args.ConstructibleType != null && !canalIndex(args.ConstructibleType);
    if (state.enabled && type === path.type && other) {
      const at = plotOf(args);
      if (at && loadOpen().some((e) => e.plot === idx(at))) {
        log(`refused a building on the canal at ${at.x},${at.y}`);
        return false;
      }
    }
    if (!state.enabled || state.multiplayer || type !== path.type || !args
      || !canalIndex(args.ConstructibleType)) return oSend(cityID, type, args, ...rest);
    const loc = plotOf(args);
    // never prepare a resource tile or park land: the building will be refused, and the district would already have
    // replaced whatever improvement stood there
    if (!loc || !isIsthmus(loc) || hasResource(loc) || isParkland(loc)) return oSend(cityID, type, args, ...rest);
    const def = canalDef(args.ConstructibleType);
    const general = safe(() => path.oCan.call(path.host, cityID, path.type,
      { ConstructibleType: args.ConstructibleType }, false), null);
    if (path.purchase && engineSaysNo(general) && unlockedByMod(cityOwner(cityID), def, general)) {
      const price = modPrice(cityID, def);
      if (price.short) { log(`not enough gold for the Canal at ${loc.x},${loc.y} (${price.cost})`); return false; }
      const place = () => safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
        { Kind: "CONSTRUCTIBLE", Type: def.ConstructibleType, Location: { x: loc.x, y: loc.y }, Owner: cityOwner(cityID) }));
      districtThenBuild(cityID, loc, args.ConstructibleType, place, { ...path, soldFor: price.cost });
      return true;
    }
    districtThenBuild(cityID, loc, args.ConstructibleType, () => oSend(cityID, type, args, ...rest), path);
    return true;
  };
}

/** Wrap one host's canStart/sendRequest for the operation that places a building through it. */
function wrapHost(host, type, purchase) {
  if (!host || typeof host.canStart !== "function" || typeof host.sendRequest !== "function") return null;
  const saved = { host, canStart: host.canStart, sendRequest: host.sendRequest };
  const path = { host, type, purchase, oCan: saved.canStart };
  host.canStart = wrapCanStart(saved.canStart.bind(host), type, purchase);
  host.sendRequest = wrapSendRequest(saved.sendRequest.bind(host), path);
  if (typeof host.canStartQuery === "function") {
    saved.canStartQuery = host.canStartQuery;
    host.canStartQuery = wrapCanStartQuery(saved.canStartQuery.bind(host), host, type);
  }
  return saved;
}

// canal sites
//
// The Canal requires a site marker on its tile (data/canals-sites.xml, Constructible_RequiredFeatures), so the engine
// offers it, to the game's own AI as to the player, only on a tile this script has marked. The canal rule itself (a
// strip of land between two shores, each age's chain rule) is the script's: the engine's data cannot express it, and
// the game's AI obeys only the data. Runs m1-m7 (2026-09-29): with the marker required, the AI weighed and built the
// building on marked tiles only, over 12 turns and through a save; growth still offers a marked tile; the marker holds
// no yield of its own, so the tile yields what it did.
// The script marks:
//   - for each AI player, every tile of its settlements where a canal is worth digging (canalWorth). The game's own
//     AI then decides for itself whether and when to build the Canal there, with production or gold, as it does any
//     building; a Canal it finishes opens like the player's;
//   - for the player, the tile of each Canal order, as the order is placed (the player's list is this script's own);
//   - every tile with a Canal in any settlement's build queue, until the order is done with (queuedCanalPlots);
//   - every opened canal, under its Canal building (markCanalTile).
// A marker put on a tile that held vegetation, wetland or a floodplain replaces it; that feature is kept (SITES_KEY)
// and put back when the tile stops being a site with no Canal begun on it. Loaded without the mod, a save has
// no markers (m6b).

function aiMajors() {
  const out = [];
  for (let pid = 0; pid < 64; pid++) {
    if (pid === state.localId) continue;
    const p = safe(() => Players.get(pid), null);
    if (!p || !safe(() => p.isAlive, false) || !safe(() => p.isMajor, false) || safe(() => p.isHuman, false)) continue;
    out.push(pid);
  }
  return out;
}

/** The Canal on offer now (see isOfferedCanal). */
function thisAgesCanal() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d && isOfferedCanal(d)) return d;
  }
  return null;
}

const SITE_FEATURE = "FEATURE_CANALS_SITE";
/** The one-tile Canal's own marker: each kind of Canal is offered by the engine only where its marker stands, so the
 * AI builds the Canal of the mode in play and never the other (data/canals-sites.xml). */
const ONE_TILE_SITE_FEATURE = "FEATURE_CANALS_SITE_ONE_TILE";
const SITE_FEATURES = [SITE_FEATURE, ONE_TILE_SITE_FEATURE];
const SITES_KEY = "Canals_Sites_v1";

/** The marker a Canal of this type needs. */
function markerFor(type) { return type === ONE_TILE_CANAL ? ONE_TILE_SITE_FEATURE : SITE_FEATURE; }
/** The marker for a new Canal: the mode's. */
function offeredMarker() { return oneTileMode() ? ONE_TILE_SITE_FEATURE : SITE_FEATURE; }
function siteIndex(feature = SITE_FEATURE) { return safe(() => GameInfo.Features.lookup(feature).$index, null); }
/** The tile holds that marker, or either marker when none is named. */
function isMarked(loc, feature) {
  const f = featureOf(loc);
  return feature ? f === feature : SITE_FEATURES.includes(f);
}
/** Marked plots, each with the feature the marker replaced ("" for none). */
function loadSites() {
  const s = safe(() => JSON.parse(String(Configuration.getGame().getValue(SITES_KEY))), null);
  return s && typeof s === "object" ? s : {};
}
function saveSites(s) { safe(() => Configuration.editGame().setValue(SITES_KEY, JSON.stringify(s))); }

/**
 * Set a tile's feature (an index, or FeatureTypes.NO_FEATURE) and wait for it to read back. One feature cannot replace
 * another in a single call: the old one goes and nothing comes in its place (m8, five tiles of five); cleared first,
 * the new one lands. True once the tile reads as asked.
 */
async function putFeature(loc, f) {
  const want = f === FeatureTypes.NO_FEATURE ? "" : safe(() => String(GameInfo.Features.lookup(f).FeatureType), "?");
  const at = { x: loc.x, y: loc.y };
  // never while a save is written: the save thread reads the map. Wait it out; a save that runs on is left alone.
  // (Only the write itself: a save that is waiting for an opening to finish must not hold up the opening's marker.)
  for (let k = 0; k < 50 && state.saving; k++) await sleep(100);
  if (state.saving) return false;
  if (featureOf(loc) && featureOf(loc) !== want) {
    safe(() => WorldBuilder.MapPlots.setFeature(FeatureTypes.NO_FEATURE, at));
    for (let k = 0; k < 30 && featureOf(loc); k++) await sleep(100);
  }
  if (want && featureOf(loc) !== want) {
    safe(() => WorldBuilder.MapPlots.setFeature(f, at));
    for (let k = 0; k < 30 && featureOf(loc) !== want; k++) await sleep(100);
  }
  return featureOf(loc) === want;
}

/** Put a marker (by default the mode's) on a tile, keeping the feature it replaces; the other marker, there since the
 * mode changed, is replaced. True once it reads back. */
async function markSite(loc, feature = offeredMarker()) {
  if (isMarked(loc, feature)) return true;
  const f = siteIndex(feature);
  if (f == null || isWater(loc) || !clearableFeature(loc)) return false;
  const sites = loadSites(); const plot = idx(loc);
  if (!(plot in sites)) { sites[plot] = isMarked(loc) ? "" : featureOf(loc); saveSites(sites); }
  return putFeature(loc, f);
}

/**
 * The marker under an opened canal's Canal building, recorded like a site (it goes with the rest should the tile
 * ever hold no canal). The marker is valid on coast for this (data/canals-sites.xml) and yields what bare coast does.
 */
async function markCanalTile(loc) {
  const marker = markerFor((canalOn(loc) || {}).type);
  const f = siteIndex(marker);
  if (f == null) return false;
  const sites = loadSites(); const plot = idx(loc);
  // Whatever the marker replaced when the tile was ordered went with the flip, for good: the record holds nothing,
  // or the woods would come back onto the water and take the fishing boat with them (fx6).
  if (sites[plot] !== "") { sites[plot] = ""; saveSites(sites); }
  const ok = isMarked(loc, marker) || await putFeature(loc, f);
  if (!ok) log(`canal at ${loc.x},${loc.y}: the site marker did not land on the opened tile`);
  return ok;
}

/**
 * Plots with a Canal in a settlement's build queue, the AI's included. The engine holds such an order until the
 * building lands, and it may hold it only where the marker is (Constructible_RequiredFeatures): an AI's queued Canal
 * whose site is no longer worth marking must keep its marker until the order is done with, or the engine is left
 * with a build it can no longer place. The player's own orders are kept the same way through loadPending.
 */
function queuedCanalPlots() {
  const out = new Map();
  for (const [p, o] of queuedCanalOrders()) out.set(p, o.pid);
  return out;
}
/** The Canal type of a queue item (its constructible index or type hash). */
function queuedType(it) {
  return String((canalDef(it.constructibleType) || canalDef(it.type) || {}).ConstructibleType || "");
}
/** The same, with the Canal type each order is for (its marker must stay under it). */
function queuedCanalOrders() {
  const types = new Set();
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (!d) continue;
    types.add(d.$index);
    const h = safe(() => GameInfo.Types.lookup(t).Hash, null);
    if (h != null) types.add(h);
  }
  const out = new Map();
  const players = aiMajors(); if (state.localId >= 0) players.push(state.localId);
  for (const pid of players) {
    for (const city of safe(() => Players.get(pid).Cities.getCities() || [], [])) {
      for (const it of safe(() => city.BuildQueue.getQueue() || [], [])) {
        if (![it.constructibleType, it.type].some((t) => t != null && types.has(t))) continue;
        const l = it.location;
        if (!l || l.x == null || l.x < 0) continue;
        out.set(idx({ x: l.x, y: l.y }), { pid, type: queuedType(it) });
      }
    }
  }
  return out;
}

/** Take the marker off and put back the feature it replaced. */
async function unmarkSite(loc) {
  const sites = loadSites(); const plot = idx(loc);
  const was = sites[plot] ? safe(() => GameInfo.Features.lookup(sites[plot]).$index, null) : null;
  delete sites[plot]; saveSites(sites);
  if (isMarked(loc)) await putFeature(loc, was != null ? was : FeatureTypes.NO_FEATURE);
}

/** Every tile where a canal is worth it to the AI player that owns it, with its worth. */
function aiSites() {
  const out = new Map();
  for (const pid of aiMajors()) {
    for (const city of safe(() => Players.get(pid).Cities.getCities() || [], [])) {
      for (const p of eligiblePlots(city.id, true)) {
        const w = canalWorth(locOf(p));
        if (w.worth > 0) out.set(p, { pid, why: w.why, feature: offeredMarker() });
      }
    }
  }
  return out;
}

/** Marks every wanted tile not yet marked. Returns how many were marked. */
async function markWanted(want) {
  let added = 0;
  for (const [p, w] of want) {
    const loc = locOf(p);
    if (isMarked(loc, w.feature) || !await markSite(loc, w.feature)) continue;
    added++;
    if (w.why !== "ordered") log(`site marked for AI ${w.pid} at ${loc.x},${loc.y} (${w.why})`);
  }
  return added;
}

/** Unmarks every tile the script marked that is no longer wanted, unless a Canal stands on it. An opened canal (water
 * with its Canal) keeps the marker under the building; water with no canal is dropped from the list, its marker
 * cleared. Returns how many were unmarked. */
async function unmarkStale(want) {
  let removed = 0;
  for (const key of Object.keys(loadSites())) {
    const p = Number(key); const loc = locOf(p);
    if (isWater(loc)) {
      if (canalOn(loc)) { if (!isMarked(loc, markerFor(canalOn(loc).type))) await markCanalTile(loc); continue; }
      if (isMarked(loc)) await putFeature(loc, FeatureTypes.NO_FEATURE);
      const s = loadSites(); delete s[p]; saveSites(s); continue;
    }
    if (want.has(p) || canalOn(loc)) continue;
    await unmarkSite(loc); removed++;
  }
  return removed;
}

/** Marks every AI site, every tile of a Canal order or queued Canal, and the opened canals; unmarks the rest. */
async function syncSites() {
  if (!state.enabled || state.multiplayer || state.syncing || siteIndex() == null) return;
  state.syncing = true;
  try {
    const want = aiSites();
    // An order already given keeps the marker of the Canal it is for, whatever the mode is now.
    const queued = queuedCanalOrders();
    for (const [p, o] of queued) want.set(p, { pid: o.pid, why: "queued", feature: markerFor(o.type) });
    for (const p of loadPending()) if (!want.has(p)) want.set(p, { pid: state.localId, why: "ordered", feature: offeredMarker() });
    const added = await markWanted(want);
    const removed = await unmarkStale(want);
    // canals opened before the marker was kept on the tile (Canals 1.2.0 saves), and any that lost it
    for (const e of loadOpen()) {
      const l = locOf(e.plot);
      if (isWater(l) && canalOn(l) && !isMarked(l, markerFor(canalOn(l).type))) await markCanalTile(l);
    }
    if (added || removed) log(`sites: ${added} marked, ${removed} unmarked, ${want.size} held`);
  } finally { state.syncing = false; }
}

// What a canal is worth, in tiles of sailing. Two shores of the same sea: the tiles a ship saves by cutting through
// instead of sailing round. Two separate bodies of water: the size of the smaller one, since that is what the cut
// opens up. A search that goes AI_WORTH_REACH tiles without meeting the far shore counts as that far round.
const AI_MIN_SAVING = 6;
const AI_MIN_BODY = 10;
const AI_WORTH_REACH = 30;

/** The runs of open water around the hex, in ring order, each a list of its water tiles. */
function waterSides(loc) {
  const ring = RING.map((d) => neighborIn(loc, d));
  const water = ring.map((n) => !!(n && isOpenWater(n)));
  if (water.every(Boolean)) return [ring];
  const start = water.findIndex((w) => !w);
  const sides = []; let cur = null;
  for (let k = 1; k <= 6; k++) {
    const i = (start + k) % 6;
    if (water[i]) { if (!cur) sides.push(cur = []); cur.push(ring[i]); } else cur = null;
  }
  return sides;
}

/** Breadth-first over open water from the given tiles (never through `avoid`): distance by plot, and whether the
 * search ran out of water before `reach`. */
function sailFrom(tiles, avoid, reach) {
  const dist = new Map(); let frontier = [];
  for (const t of tiles) { const p = idx(t); if (!dist.has(p)) { dist.set(p, 0); frontier.push(t); } }
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next = [];
    for (const t of frontier) {
      for (const n of neighbors(t)) {
        const p = idx(n);
        if (p === avoid || dist.has(p) || !isOpenWater(n)) continue;
        dist.set(p, d); next.push(n);
      }
    }
    frontier = next;
  }
  return { dist, closed: frontier.length === 0 };
}

/** The worth of joining shore B to the water already searched from shore A (`from`), with the reason. */
function pairWorth(from, sideB, me) {
  const hit = sideB.map((t) => from.dist.get(idx(t))).filter((d) => d != null);
  if (hit.length) {
    // shore to shore round the water, against two steps through the cut
    const saves = Math.min(...hit) - 2;
    return { worth: saves >= AI_MIN_SAVING ? saves : 0, why: `saves ${saves}` };
  }
  const far = sailFrom(sideB, me, AI_WORTH_REACH);
  const small = Math.min(from.closed ? from.dist.size : Infinity, far.closed ? far.dist.size : Infinity);
  if (small === Infinity) return { worth: AI_WORTH_REACH, why: "far round" };
  return { worth: small >= AI_MIN_BODY ? Math.min(small, AI_WORTH_REACH) : 0, why: `joins a body of ${small}` };
}

/**
 * The best worth of a cut here over every pair of its shores, with the reason. 0 when no pair is worth digging: a
 * pond, or two shores already a short sail apart.
 */
function canalWorth(loc) {
  const sides = waterSides(loc);
  if (sides.length < 2) return { worth: 0, why: "one shore" };
  const me = idx(loc); let best = null;
  for (let a = 0; a < sides.length - 1; a++) {
    const from = sailFrom(sides[a], me, AI_WORTH_REACH);
    for (let b = a + 1; b < sides.length; b++) {
      const w = pairWorth(from, sides[b], me);
      if (!best || w.worth > best.worth) best = w;
    }
  }
  return best;
}

// telling the player

/**
 * The dialog box sets its body as one centred run of text-base type with no width of its own, so a message of a few
 * sentences drew one long line across a wide box. The body of the mod's box is given a reading width and the next
 * type size up, found by its text once the box is on screen.
 */
function styleDialogBody(text) {
  const want = String(Locale.compose(text)).replace(/\[N\]/g, "").slice(0, 40);
  let tries = 0;
  const find = () => {
    const el = Array.from(document.querySelectorAll('[role="paragraph"]')).find((p) => (p.textContent || "").startsWith(want));
    if (!el) { if (++tries < 40) setTimeout(find, 100); return; }
    el.classList.remove("text-base"); el.classList.add("text-lg");
    el.style.maxWidth = "34rem"; el.style.marginLeft = "auto"; el.style.marginRight = "auto";
    el.style.lineHeight = "1.4";
  };
  find();
}

/** A message box, once per game; in a network game (whose settings belong to the host) once per session. */
async function tellOnce(key, body) {
  if (state.multiplayer) {
    if (state.told.has(key)) return;
    state.told.add(key);
  } else {
    if (safe(() => Configuration.getGame().getValue(key), null)) return;
    safe(() => Configuration.editGame().setValue(key, "1"));
  }
  try {
    const { DialogBoxManager } = await import("/core/ui/dialog-box/manager-dialog-box.js");
    DialogBoxManager.createDialog_Confirm({ title: "LOC_CANALS_MOD_NAME", body });
    styleDialogBody(body);
    log(`told the player: ${key}`);
  } catch (e) { log("message not shown: " + e); }
}

/**
 * A save from Canals 1.0.0 holds its canals as Coast, so the load drew them as open sea, and that look stays for the
 * session (c99: the hex kept its sea mesh after the retype to land). One save and load draws them as canals
 * again, since every save now holds them as land. The mod offers to do both: this turn's autosave is written through
 * the wrapped save call and then loaded. Declined, the look comes right after the player's own next save and load.
 */
async function offerReload() {
  try {
    const { DialogBoxManager } = await import("/core/ui/dialog-box/manager-dialog-box.js");
    DialogBoxManager.createDialog_MultiOption({
      title: "LOC_CANALS_MOD_NAME", body: "LOC_CANALS_NOTICE_OLD_SAVE", canClose: false,
      options: [
        { actions: ["accept"], label: "LOC_CANALS_RELOAD_NOW", callback: reloadThroughSave },
        { actions: ["cancel", "keyboard-escape"], label: "LOC_CANALS_RELOAD_LATER", callback: () => log("reload declined") },
      ],
    });
    styleDialogBody("LOC_CANALS_NOTICE_OLD_SAVE");
    log(`offered a reload for ${state.staleLoad.length} canal(s) saved as Coast`);
  } catch (e) { log("reload offer not shown: " + e); }
}
function reloadThroughSave() {
  const name = autosaveName(safe(() => Game.turn, 0));
  state.reloadFrom = name;
  const ok = safe(() => Network.saveGame({ ...autosaveParams(name), Overwrite: true }), false);
  if (!ok) state.reloadFrom = null;
  log(`reload: writing ${name} ${ok ? "sent" : "refused"}`);
}

/** Once the game is up: what the player cannot tell from the lists alone. */
function notices() {
  if (state.multiplayer) { tellOnce("Canals_Told_Multiplayer", "LOC_CANALS_NOTICE_MULTIPLAYER"); return; }
  if (state.staleLoad.length) offerReload();
  const def = thisAgesCanal();
  const city = safe(() => Players.get(state.localId).Cities.getCities()[0], null);
  const build = state.originals && state.originals.hosts[0];
  if (!def || !city || !build) return;
  const general = safe(() => build.canStart.call(build.host, city.id, CityOperationTypes.BUILD,
    { ConstructibleType: def.$index }, false), null);
  if (!unlockedByMod(state.localId, def, general)) return;
  const tech = safe(() => GameInfo.ProgressionTreeNodes.lookup(unlockNode(def)).Name, "");
  tellOnce("Canals_Told_SoldByMod_" + def.ConstructibleType, Locale.compose("LOC_CANALS_NOTICE_SOLD_BY_MOD", def.Name, tech));
}

/** Run fn a few seconds after the game has started (the loading screen gone). */
function whenStarted(fn, delay) {
  const t0 = Date.now();
  const poll = () => {
    const up = safe(() => UI.getGameLoadingState() === UIGameLoadingState.GameStarted, Date.now() - t0 > 15000);
    if (up) setTimeout(fn, delay); else setTimeout(poll, 500);
  };
  poll();
}

// install

function install() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d) { state.canalIndexes.add(d.$index); safe(() => state.canalIndexes.add(GameInfo.Types.lookup(t).Hash)); }
  }
  if (!state.canalIndexes.size) { log("no Canal buildings in the database; inactive"); return false; }
  state.multiplayer = !!safe(() => Configuration.getGame().isNetworkMultiplayer, false);
  // A game keeps the rules it started with: the main menu's choice is written into the save the first time it loads.
  if (!state.multiplayer && !safe(gameHasMode, true)) safe(() => pinModeToGame(getMode()));
  const build = wrapHost(safe(() => Game.CityOperations, null), safe(() => CityOperationTypes.BUILD, null), false);
  if (!build) { log("Game.CityOperations not wrappable; inactive"); return false; }
  state.originals = { hosts: [build] };
  // Towns get buildings only by purchase, which goes through Game.CityCommands, not the production queue.
  const purchase = wrapHost(safe(() => Game.CityCommands, null), safe(() => CityCommandTypes.PURCHASE, null), true);
  if (purchase) state.originals.hosts.push(purchase);
  else log("Game.CityCommands not wrappable; Canals cannot be bought with gold");
  safe(() => engine.on("ConstructibleBuildCompleted", onBuildCompleted));
  safe(() => engine.on("StartSaveRequest", onSaveStart));
  safe(() => engine.on("SaveComplete", onSaveDone));
  state.localId = safe(() => GameContext.localPlayerID, -1);
  safe(() => engine.on("PlayerTurnDeactivated", onTurnDeactivated));
  const net = safe(() => Network, null);
  if (net && typeof net.saveGame === "function") state.originals.saveGame = wrapSaveGame(net);
  else log("Network.saveGame not wrappable; a save made from the menu reloads canals as open water");
  if (!state.multiplayer) { keepLandLook(); holdEngineAutosave(); wrapOptionsScreen(); }
  safe(() => engine.on("PlayerTurnActivated", onTurnActivated));
  safe(() => engine.on("GameAgeEnded", onAgeEnded));
  safe(() => engine.on("BeforeAgeTransition", onAgeEnded));
  whenStarted(notices, 5000);
  const uhost = safe(() => Game.UnitOperations, null);
  if (uhost && typeof uhost.sendRequest === "function") { state.originals.unitSend = uhost.sendRequest; uhost.sendRequest = wrapUnitSend(uhost.sendRequest.bind(uhost)); }
  log(`active${state.multiplayer ? " (network game: canals not offered)" : ""}: Canal placement limited to isthmus tiles; ` +
    `rules: ${oneTileMode() ? "one-tile canals" : "by age"}`);
  return true;
}

function uninstall() {
  for (const h of (state.originals && state.originals.hosts) || []) {
    h.host.canStart = h.canStart; h.host.sendRequest = h.sendRequest;
    if (h.canStartQuery) h.host.canStartQuery = h.canStartQuery;
  }
  const uhost = safe(() => Game.UnitOperations, null);
  if (uhost && state.originals && state.originals.unitSend) uhost.sendRequest = state.originals.unitSend;
  safe(() => engine.off("StartSaveRequest", onSaveStart));
  safe(() => engine.off("SaveComplete", onSaveDone));
  safe(() => engine.off("PlayerTurnDeactivated", onTurnDeactivated));
  safe(() => engine.off("PlayerTurnActivated", onTurnActivated));
  safe(() => engine.off("GameAgeEnded", onAgeEnded));
  safe(() => engine.off("BeforeAgeTransition", onAgeEnded));
  const net = safe(() => Network, null);
  if (net && state.originals && state.originals.saveGame) net.saveGame = state.originals.saveGame;
  const opt = state.originals && state.originals.addOption;
  if (opt) opt.host.addOption = opt.add;
  state.enabled = false;
  log("uninstalled");
}

if (!G[KEY]) {
  G[KEY] = {
    version: "1.4.2",
    set enabled(v) { state.enabled = !!v; },
    get enabled() { return state.enabled; },
    uninstall, isIsthmus, eligiblePlots, openCanal, sweep, loadPending, loadOpen, localTurnActive,
    districtHolder, repairCitylessDistricts,
    drawOverlay, clearOverlay, redrawNeighbours, hasResource,
    aiMajors, thisAgesCanal, waterAreas, reloadThroughSave, canalWorth, waterSides, syncSites, aiSites, markSite,
    unmarkSite, loadSites, queuedCanalPlots, queuedCanalOrders, markCanalTile,
    get mode() { return oneTileMode() ? "one-tile" : "ages"; },
    get staleLoad() { return state.staleLoad.slice(); },
    channelArms: (loc) => ({ water: waterSideIndexes(loc), arms: runArms(runOf(loc)).get(idx(loc)) || [] }),
  };
  install();
}
