// canals.js - Canals, a Civilization VII mod. Game scope.
//
// What it does (every step watched 2026-09-25 on 1.5.0, see docs/verification-runs.md):
//   1. Placement. The Canal buildings (data/canals.xml) carry no terrain rule of their own; this script decides
//      where they may go by wrapping the two calls that place a building: Game.CityOperations BUILD (production)
//      and Game.CityCommands PURCHASE (gold, the only way a town gets a building). For a Canal, the offered plots
//      are the city's land tiles with water on at least two separate sides (a strip of land between coasts, the
//      same sea or not), and the per-plot check refuses anything else. The same verdict is written into
//      canStartQuery, which is what the production and purchase lists are built from.
//   2. Commit. A Canal BUILD or PURCHASE on an isthmus without an urban district first gets one (CREATE_ELEMENT
//      DISTRICT), then the order is forwarded; if the engine refuses it the district is removed again. The tile is
//      remembered in the save (GameConfiguration key) so a reload mid-construction still finishes the job. A
//      purchased Canal lands complete with no completion event (watched, c36), so the commit opens it.
//   3. Completion. On ConstructibleBuildCompleted for a Canal on an isthmus: the tile is retyped to Coast
//      (WorldBuilder.MapPlots.setTerrain, the feature cleared first), the Canal building and its district are
//      destroyed and the plot bought back, so the finished canal is a bare water hex the city owns that ships path
//      through at once; a canal look (channel, quay, boats) is drawn on it from shipped meshes. A Canal completed on
//      a tile that is not an isthmus (an AI's, or a stale save) is left alone.
//   4. Safety net. On load and at the start of every turn, every remembered tile and every complete Canal on the
//      map is re-checked, so a missed event is caught on the next turn.
//   Multiplayer: the terrain retype is a local call, not a networked operation, so in a network game the Canal is
//   not offered and completed Canals are left as buildings.
"use strict";

const TAG = "[Canals]";
const G = globalThis;
const KEY = "__canals";
const PERSIST_KEY = "Canals_Pending_v1";
const OPEN_KEY = "Canals_Open_v1";
const CANAL_TYPES = ["BUILDING_CANAL_ANTIQUITY", "BUILDING_CANAL_EXPLORATION", "BUILDING_CANAL_MODERN"];
const SETTLE_MS = 400;
const BUILD_LAND_MS = 6000;
const BUILD_RADIUS = 3;
/** Ships that may pass a canal per turn, by its age; the local player's orders are the only ones a script can hold. */
const TRANSITS_PER_TURN = { AGE_ANTIQUITY: 1, AGE_EXPLORATION: 2, AGE_MODERN: Infinity };

function log(m) { try { console.error(TAG + " " + m); } catch (_) { /* ignore */ } }
function safe(fn, fb) { try { return fn(); } catch (_e) { return fb; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function J(o) { try { return JSON.stringify(o); } catch (_) { return "?"; } }

// --- map reads -----------------------------------------------------------------------------------

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
 * A finished canal keeps the area id of the land it was cut from (watched: the engine never recalculates areas
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
      if (visited.has(p) || !isWater(w) || featureOf(w) === "FEATURE_ICE") continue;
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
/** Water a ship can sail: sea, lake, or a navigable river tile (which the engine's water flag does not cover). */
function isOpenWater(loc) { return (isWater(loc) || safe(() => GameplayMap.isNavigableRiver(loc.x, loc.y), false)) && featureOf(loc) !== "FEATURE_ICE"; }
/** The same, plus a settlement center, which is a canal end too. */
function isShipWater(loc) { return isOpenWater(loc) || isSettlementCentre(loc); }

/**
 * How many separate ways a ship can reach the hex: walking the six neighbors in ring order, a run of open water
 * (ice not counted) is one way in, and a settlement center beside the tile is one of its own. Two ways in means
 * the tile is a strip of land between two shores, whether or not those shores belong to the same sea: three coast
 * tiles on one side and one on the other is two; five coast tiles in a row (a headland) is one.
 * A center is counted apart from the water rather than as a piece of it. Counted as water it could bridge the gap
 * between a neck's two shores and read them as a single stretch, so founding a settlement next to a neck took the
 * neck's own site away (watched, c48: a Modern town beside a two-shore neck left it unbuildable).
 */
/** A ship-water neighbor in that ring direction. Cliffs do not matter: the retype clears the plot's cliff flags
 * (watched, c21); only their drawn rock faces remain until the next load. */
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
 * town, built or bought, even with an urban district in place, and gives no reason (watched, c53 to c55: Canal,
 * Grocer and Fishing Quay refused on an ivory and a wine tile, all three taken on a plain tile beside them; not one
 * urban tile on the whole map held a resource). The Canal is a building, and a script cannot clear a resource
 * (ResourceBuilder is map-generation only), so such a tile is never offered.
 */
function hasResource(loc) {
  return safe(() => GameplayMap.getResourceType(loc.x, loc.y) !== ResourceTypes.NO_RESOURCE, false);
}

/**
 * Whether a canal may clear the tile's feature: vegetation, wetland and floodplain go when the tile turns to water.
 * A natural wonder is never dug away, whatever class it carries (Zhangjiajie is classed wet, the Barrier Reef
 * vegetated), and nor is anything else without one of those classes (a volcano, ice).
 */
let wonderFeatures = null;
function clearableFeature(loc) {
  const f = featureOf(loc);
  if (!f) return true;
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
 * A tile beside a canal always joins that canal's run and is judged by the run rule: a canal's own water never
 * makes its neighbor a two-shore isthmus on its own (watched gal-exp: that hole let a fourth tile onto a run's
 * side and drew a branched blob in the Exploration age).
 */
function isIsthmus(loc) {
  if (!isCuttable(loc)) return false;
  const rule = CHAIN_RULES[currentAge()] || CHAIN_RULES.AGE_ANTIQUITY;
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

// --- persistence ---------------------------------------------------------------------------------

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

// --- the canal itself -----------------------------------------------------------------------------

const state = {
  enabled: true, originals: null, canalIndexes: new Set(), busy: new Set(),
  // canals opened in this session: their cliff faces are still drawn (a load redraws the hex without them)
  openedHere: new Set(),
  // canals whose hex is drawn as land this session: opened in it, or loaded as land (see keepLandLook)
  landMesh: new Set(), saving: false, hold: false, loading: false, pendingSave: false, aiRunning: false, localId: -1,
  multiplayer: false, paidTurn: -1, transits: new Map(), transitTurn: -1,
  // the age has ended (GameAgeEnded); the canals stay land for the transition
  ageEnded: false,
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

/** Retype a land tile to Coast; resolves true when the read confirms it. */
async function flipToCoast(loc) {
  const coast = safe(() => GameInfo.Terrains.lookup("TERRAIN_COAST").$index, -1);
  if (coast < 0) return false;
  try {
    WorldBuilder.startBlock();
    if (featureOf(loc)) WorldBuilder.MapPlots.setFeature(FeatureTypes.NO_FEATURE, loc);
    WorldBuilder.MapPlots.setTerrain(coast, loc);
    WorldBuilder.endBlock();
  } catch (e) { log("setTerrain threw " + e); return false; }
  for (let k = 0; k < 30; k++) { await sleep(100); if (terrainOf(loc) === "TERRAIN_COAST") return true; }
  return false;
}

/**
 * A Canal has completed on `loc`: make it a canal. Owner may be any player; the local client does the work
 * (single player only, see the multiplayer note above).
 */
async function openCanal(loc, owner) {
  const plot = idx(loc);
  if (state.busy.has(plot) || state.hold) return; // held: the next sweep opens it (see keeping the land look)
  state.busy.add(plot);
  try {
    const canal = canalOn(loc);
    if (!canal || !canal.complete) return;
    if (terrainOf(loc) === "TERRAIN_COAST") return; // already a canal (the Canal building stays on the finished tile)
    if (state.saving || loadOpen().some((e) => e.plot === plot)) return; // an open canal, land only while a save runs
    if (occupants(loc).some((o) => o.type !== canal.type && !isImprovement(o.type))) { log(`Canal at ${loc.x},${loc.y} shares its tile with other buildings; left as a building`); forget(plot); return; }
    if (!isIsthmus(loc)) { log(`Canal at ${loc.x},${loc.y} is not on a canal site; left as a building`); forget(plot); return; }
    const who = owner != null ? owner : canal.owner;
    const local = GameContext.localPlayerID;
    const cityId = safe(() => {
      const c = GameplayMap.getOwningCityFromXY(loc.x, loc.y);
      return c && c.id !== -1 ? c : null;
    }, null);
    // The retype clears the plot's cliff flags but leaves the rock faces drawn; remember which shores were cliffs
    // so the overlay can dress them as locks.
    const cliffSides = cliffSideIndexes(loc);
    const landType = terrainOf(loc);
    const flipped = await flipToCoast(loc);
    if (!flipped) { log(`Canal at ${loc.x},${loc.y}: terrain did not change; left as a building`); return; }
    // The Canal and its urban district go: an urban district draws a block of houses over the hex, which hides the
    // canal (watched, run c14). The citizen the Canal housed comes back as a pending point and is placed on the
    // finished canal with the game's own expand order, which makes it a worked rural fishing tile (watched, c23);
    // the invisible works building of the canal's age then adds its food and gold to the city natively.
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: canal.owner, LocalID: canal.id }));
    await sleep(300);
    const did = districtIdAt(loc);
    if (did) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "DISTRICT", Owner: did.owner, LocalID: did.id }));
    await sleep(1200);
    // Removing the district releases the plot (watched); give it back to the city.
    if (cityId && safe(() => GameplayMap.getOwner(loc.x, loc.y), -1) !== who) {
      safe(() => Cities.get(cityId).purchasePlot({ x: loc.x, y: loc.y }));
      await sleep(1500);
    }
    forget(plot);
    const age = canal.type === "BUILDING_CANAL_MODERN" ? "AGE_MODERN" : canal.type === "BUILDING_CANAL_EXPLORATION" ? "AGE_EXPLORATION" : "AGE_ANTIQUITY";
    await settleCanalTile(loc, cityId, who, canal.type);
    rememberOpen(plot, age, cliffSides, landType);
    state.openedHere.add(plot); state.landMesh.add(plot);
    const drawn = drawOverlay(loc, age, cliffSides);
    const redrawn = redrawNeighbours(loc);
    log(`canal opened at ${loc.x},${loc.y} for player ${who}: ${terrainOf(loc)} district=${districtAt(loc) || "none"} owner=${safe(() => GameplayMap.getOwner(loc.x, loc.y))} overlay=${drawn} neighboursRedrawn=${redrawn}`);
  } finally { state.busy.delete(plot); }
}

// --- the look, in-session --------------------------------------------------------------------------
//
// A retyped hex keeps its land mesh until the next load (the engine redraws it as water then). Until then the
// canal is drawn by script from shipped meshes (watched 2026-09-25, runs c11 to c13): one river channel piece per
// water side, meeting at the hex center, a stone quay with cranes along the first arm, and moored river boats.
// The model group lives for the session; after a reload the engine's own water and quay take over.

const ARM_ASSET = "TER_Decal_RiverPiece_Straight";
const BOATS_ASSET = "IMP_FishingBoat_River_I_W_O_E";
/**
 * Per age, several looks; a canal takes the one its plot number selects, so it keeps that look across reloads.
 * Each entry: whether the river-city house layout is drawn (with which attachment set), and the props placed along
 * the first arm as [asset, along, left, scale]. Watched 2026-09-25 (runs c16, c17, c19): the harbors, the wharf,
 * the shipyard and the layouts; the pier B and Modern pier pieces are siblings of watched pieces.
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
  // "left" of an arm (alongArm's +y) is counter-clockwise on screen, which is the PREVIOUS ring index
  // (armAngle turns counter-clockwise as the index falls); watched c32: the props sat on the next arm with +1.
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
 * Watched 2026-09-25 (runs c29, c30): further out than 0.42 the chamber vanishes into the cliff mesh. The looping
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
  const look = (AGE_LOOKS[age] || AGE_LOOKS.AGE_ANTIQUITY)[plot % 3];
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
 * district, fishing boats, a worker: watched c23), then the age's invisible works building is created there. If the
 * expand order does not offer the tile, a rural district is created directly and the citizen stays pending for the
 * player to place.
 */
async function settleCanalTile(loc, cityId, owner, canalType) {
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  if (cityId && owner === local) {
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
  if (districtAt(loc) === "") { safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT", { Kind: "DISTRICT", Type: "DISTRICT_RURAL", Location: { x: loc.x, y: loc.y }, Owner: owner })); for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100); }
  if (!occupants(loc).some((o) => o.type === canalType)) { safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT", { Kind: "CONSTRUCTIBLE", Type: canalType, Location: { x: loc.x, y: loc.y }, Owner: owner })); await sleep(1500); }
}

// --- keeping the land look across loads --------------------------------------------------------------
//
// A load draws each hex from the terrain in the save, and a Coast hex comes out as open sea: the canal was gone
// from sight after every reload. So a canal is land in every save and Coast while the player plays; after a load it
// is turned to Coast again at once and drawn over the land mesh.
//
// The retype must land BEFORE a save starts, never during one: a canal retyped inside StartSaveRequest crashed the
// game on the save's worker thread (c71, c75: same stack), while the same canal already land when the autosave began
// saved cleanly (c74). Every save the UI makes goes through Network.saveGame, which is wrapped: the canals go to land,
// the save is sent once the map reads them as land, and they are Coast again on SaveComplete.
//
// The engine's own autosave comes about 120 ms after TurnEnd, too close for a retype. So while any canal is open the
// mod holds the engine's autosave (its frequency set out of reach, see holdEngineAutosave) and writes the autosave
// itself through the wrapped call at the start of the player's turn, on the player's own frequency and keep count.
// The canals are Coast through every AI turn, so AI ships use them. Nothing retypes a plot while state.hold is set,
// so a Canal finished in that window opens at the next sweep.

/** Retype the opened canals: "land" turns each Coast one back to the terrain it was cut from, "coast" the reverse. */
function retypeCanals(to) {
  const changed = [];
  try {
    WorldBuilder.startBlock();
    for (const e of loadOpen()) {
      const loc = locOf(e.plot); const now = terrainOf(loc);
      if ((to === "land") !== (now === "TERRAIN_COAST")) continue;
      const want = to === "land" ? (e.land || "TERRAIN_FLAT") : "TERRAIN_COAST";
      const t = safe(() => GameInfo.Terrains.lookup(want).$index, -1);
      if (t < 0) continue;
      WorldBuilder.MapPlots.setTerrain(t, loc); changed.push(e.plot);
    }
    WorldBuilder.endBlock();
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
    landAhead("save");
    const t0 = Date.now();
    const send = () => {
      if (!readsLand() && Date.now() - t0 < 3000) { setTimeout(send, 50); return; }
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
  setTimeout(aiPlan, 3000); // after the autosave and the sweep
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
    if (c && c.complete && !opened.has(plot) && terrainOf(loc) !== "TERRAIN_COAST" && isIsthmus(loc)) openCanal(loc, c.owner);
  }
}

function onBuildCompleted(data) {
  if (!state.enabled || state.multiplayer || !data || !data.location) return;
  const def = safe(() => GameInfo.Constructibles.lookup(data.constructibleType), null);
  if (!def || !CANAL_TYPES.includes(String(def.ConstructibleType))) return;
  const loc = { x: data.location.x, y: data.location.y };
  const owner = data.constructible ? data.constructible.owner : undefined;
  setTimeout(() => openCanal(loc, owner), SETTLE_MS);
}

// --- placement and commit ---------------------------------------------------------------------------

function plotOf(args) { return args && args.X != null && args.Y != null ? { x: args.X, y: args.Y } : null; }

/** The city's land tiles that qualify, whether or not the engine offered them. */
function eligiblePlots(cityID) {
  const city = safe(() => Cities.get(cityID), null);
  if (!city) return [];
  const out = [];
  const centre = safe(() => city.location, null);
  for (const p of safe(() => city.getPurchasedPlots() || [], [])) {
    const loc = locOf(p);
    // Only tiles the city can build on: within its ring (watched: a purchased tile 12 plots out is refused).
    if (centre && safe(() => GameplayMap.getPlotDistance(centre.x, centre.y, loc.x, loc.y), 99) > BUILD_RADIUS)
      continue;
    if (!isIsthmus(loc) || hasResource(loc)) continue;
    // never a tile that holds buildings: the canal removes whatever stands on it
    const d = districtAt(loc);
    if (d !== "" && d !== "DISTRICT_RURAL") continue;
    if (occupants(loc).some((o) => !isImprovement(o.type))) continue;
    if (canalOn(loc) || loadPending().includes(p)) continue;
    if (safe(() => (MapUnits.getUnits(loc.x, loc.y) || []).length, 0) > 0) continue;
    out.push(p);
  }
  return out;
}

/**
 * The engine's verdict on WHETHER a Canal may be had at all (locked, already queued, too little gold), as opposed to
 * where. Only a plain "no suitable location" is ours to override, because that is the engine not seeing the canal
 * sites. Anything else is kept, including an unlock the player has not earned: a refusal for a locked building
 * carries no reasons at all (watched 2026-09-24, engine-closed.md), so a missing reason must not read as consent.
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
 * the engine's own urban-expansion plots included (watched, c36: a town's purchase offered three plain tiles beside it
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
    if (!isThisAgesCanal(def)) return res;
    if (state.multiplayer) return { ...res, Success: false, Plots: [], ExpandUrbanPlots: [], FailureReasons: ["LOC_CANAL_MULTIPLAYER"] };
    const loc = plotOf(args);
    if (loc) {
      if (!isIsthmus(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_NOT_ISTHMUS"] };
      if (hasResource(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_RESOURCE"] };
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
 * canStart offered the site (watched, c41 and c42). Give the Canal's entry the mod's verdict.
 */
function wrapCanStartQuery(oQuery, host, placeType) {
  return function (cityID, opType, queryType, ...rest) {
    const res = oQuery(cityID, opType, queryType, ...rest);
    const constructibles = safe(() => CityQueryType.Constructible, null);
    if (!state.enabled || opType !== placeType || !Array.isArray(res)) return res;
    if (constructibles == null || queryType !== constructibles) return res;
    for (const t of CANAL_TYPES) {
      const d = safe(() => GameInfo.Constructibles.lookup(t), null);
      if (!isThisAgesCanal(d)) continue;
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

/**
 * A Canal BUILD or PURCHASE on a tile without an urban district: create one, then forward; undo the district on
 * refusal. A purchased Canal lands complete and the engine sends no completion event for it (watched, c36), so the
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
    safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT", { Kind: "DISTRICT", Type: "DISTRICT_URBAN", Location: { x: loc.x, y: loc.y }, Owner: local }));
    for (let k = 0; k < 20 && districtAt(loc) !== "DISTRICT_URBAN"; k++) await sleep(100);
    if (districtAt(loc) !== "DISTRICT_URBAN") { log(`no urban district could be created at ${loc.x},${loc.y}; build not sent`); return; }
  }
  // The engine needs a moment before a new district counts as a site (watched: a BUILD sent 200 ms after the
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
  if (!hadDistrict) {
    const did = districtIdAt(loc);
    if (did) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "DISTRICT", Owner: did.owner, LocalID: did.id }));
    // Removing the district released the plot (watched); buy it back for the city.
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
    // never prepare a resource tile: the engine will refuse the building, and the district would already have
    // replaced whatever improvement stood there
    if (!loc || !isIsthmus(loc) || hasResource(loc)) return oSend(cityID, type, args, ...rest);
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

// --- AI canals -------------------------------------------------------------------------------------
//
// The AI places buildings by the engine's own rules and never sees a canal site, so the mod plans canals for it. At
// the start of each of the player's turns, an AI major that has this age's Canal unlocked and holds a site in one of
// its cities that joins two separate bodies of water starts a Canal there, and the city builds it as the player's
// cities do: each turn its production goes to the Canal (taken from whatever it was building, city.BuildQueue
// .addProgress, which moves any city's production: watched 2026-09-18) until the Canal's cost is paid, and the canal
// opens through the same path as the player's. An AI rich enough buys it outright at the engine's purchase price
// instead (c90). An AI gold route alone never fired: over 40 autoplayed turns no AI held the ~1,700-2,000 gold (c91).
// Each AI has one Canal under way at a time and waits AI_COOLDOWN_TURNS after one opens; one opens per turn in all.

const AI_KEY = "Canals_AI_v2";
const AI_COOLDOWN_TURNS = 8;
// an AI buys outright only with a fifth of the price again in hand (c90: AI treasuries 119-2656 against a 2000 price)
const AI_GOLD_RESERVE = 1.2;

function aiState() {
  const read = () => { const v = Configuration.getGame().getValue(AI_KEY); return v ? JSON.parse(String(v)) : null; };
  const s = safe(read, null);
  return s && typeof s === "object" ? { last: s.last || {}, projects: s.projects || {} } : { last: {}, projects: {} };
}
function aiSave(s) { safe(() => Configuration.editGame().setValue(AI_KEY, JSON.stringify(s))); }

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

function thisAgesCanal() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d && isThisAgesCanal(d)) return d;
  }
  return null;
}

/** A site worth a canal to this AI: a city tile that qualifies and joins two separate bodies of water. */
function aiCanalSite(pid, def) {
  for (const city of safe(() => Players.get(pid).Cities.getCities() || [], [])) {
    // the engine's verdict on whether this city may build the Canal at all (locked or not), with the mod's sites.
    // Judged on BUILD, not PURCHASE: a purchase verdict refuses on gold alone, which dropped every site (c92).
    const args = { ConstructibleType: def.$index };
    const can = safe(() => Game.CityOperations.canStart(city.id, CityOperationTypes.BUILD, args, false), null);
    let plots = can && Array.isArray(can.Plots) ? can.Plots : [];
    // the mod places an AI's Canal itself, so a Canal locked only because the mod came after its tech is open too
    if (!plots.length && unlockedByMod(pid, def, can)) plots = eligiblePlots(city.id);
    for (const p of plots) {
      const loc = locOf(p);
      if (districtAt(loc) === "DISTRICT_RURAL" && waterAreas(loc).size >= 2) return { city, loc };
    }
  }
  return null;
}

const unitsOnTile = (loc) => safe(() => (MapUnits.getUnits(loc.x, loc.y) || []).length, 0);

/**
 * Put a finished Canal for an AI on the site and open it. A unit on the tile makes it wait: nothing is touched.
 * The site must be a tile the AI works: on an owned tile with no district at all, neither an urban nor a rural
 * district can be created by script (c94, c95: both refused every turn, the tile left bare), while a worked tile took
 * the Canal at once (c90). aiCanalSite offers only worked tiles; if the AI stops working one, the Canal waits.
 */
async function aiPlaceCanal(pid, loc, def) {
  const local = state.localId; const plot = idx(loc);
  if (unitsOnTile(loc) > 0) { log(`AI ${pid}: a unit stands on ${loc.x},${loc.y}; the Canal waits`); return false; }
  const create = (kind, type) => safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT",
    { Kind: kind, Type: type, Location: { x: loc.x, y: loc.y }, Owner: pid }));
  const landed = () => { const c = canalOn(loc); return !!(c && c.complete); };
  const waitFor = async (ok) => { for (let k = 0; k < 50 && !ok(); k++) await sleep(100); return ok(); };
  if (districtAt(loc) === "") { log(`AI ${pid}: ${loc.x},${loc.y} is not worked now; the Canal waits`); return false; }
  remember(plot);
  for (const o of occupants(loc)) safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
  // the improvement must be gone before the Canal goes on (c97: sent straight after, the woodcutter was still there
  // and both placements were refused; c90 waited on a district in between and took)
  await waitFor(() => occupants(loc).length === 0);
  create("CONSTRUCTIBLE", def.ConstructibleType);
  if (!await waitFor(landed)) {
    // the player's path puts the Canal on an urban district; try that before giving up
    create("DISTRICT", "DISTRICT_URBAN"); await waitFor(() => districtAt(loc) === "DISTRICT_URBAN");
    create("CONSTRUCTIBLE", def.ConstructibleType); await waitFor(landed);
  }
  if (!landed()) {
    const why = { district: districtAt(loc), owner: safe(() => GameplayMap.getOwner(loc.x, loc.y)),
      units: unitsOnTile(loc), resource: hasResource(loc), built: occupants(loc).map((o) => o.type),
      terrain: terrainOf(loc) };
    log(`AI ${pid}: the Canal at ${loc.x},${loc.y} did not land ${J(why)}`);
    forget(plot);
    return false;
  }
  await openCanal(loc, pid);
  return true;
}

/** Buy outright, if the AI can afford it with gold to spare. */
async function aiBuyCanal(pid, city, loc, def) {
  const cost = safe(() => city.Gold.getBuildingPurchaseCost(YieldTypes.YIELD_GOLD, def.ConstructibleType), 0);
  const gold = safe(() => Players.get(pid).Treasury.goldBalance, 0);
  if (!(cost > 0) || gold < cost * AI_GOLD_RESERVE) return false;
  if (!await aiPlaceCanal(pid, loc, def)) return false;
  safe(() => Players.grantYield(pid, YieldTypes.YIELD_GOLD, -cost));
  log(`AI ${pid} bought a Canal at ${loc.x},${loc.y} for ${Math.round(cost)} gold (had ${Math.round(gold)})`);
  return true;
}

/** The site is still one this city can dig. */
function aiSiteHolds(pid, cityId, loc) {
  const city = safe(() => Cities.get(cityId), null);
  if (!city || safe(() => city.owner, -1) !== pid) return false;
  if (safe(() => GameplayMap.getOwner(loc.x, loc.y), -1) !== pid) return false;
  return !canalOn(loc) && isIsthmus(loc) && !hasResource(loc);
}

/** One turn of AI canal planning: work every Canal under way, start new ones, open at most one. */
async function aiPlan() {
  if (!state.enabled || state.multiplayer || state.aiRunning || ageIsOver()) return null;
  if (state.hold || state.saving || state.loading) { setTimeout(aiPlan, 1000); return null; }
  state.aiRunning = true;
  try { return await aiPlanTurn(); } finally { state.aiRunning = false; }
}
async function aiPlanTurn() {
  const def = thisAgesCanal(); if (!def) return null;
  const turn = safe(() => Game.turn, 0); const s = aiState(); let opened = null;
  for (const pid of aiMajors()) {
    const pr = s.projects[pid];
    if (pr) {
      const loc = locOf(pr.plot);
      if (pr.type !== def.ConstructibleType || !aiSiteHolds(pid, pr.cityId, loc)) {
        log(`AI ${pid}: Canal at ${loc.x},${loc.y} abandoned (site or age changed)`); delete s.projects[pid]; continue;
      }
      const city = Cities.get(pr.cityId);
      const take = Math.max(0, Math.round(safe(() => city.Yields.getNetYield(YieldTypes.YIELD_PRODUCTION), 0)));
      if (take > 0) { safe(() => city.BuildQueue.addProgress(-take)); pr.paid += take; }
      if (pr.paid >= pr.need && !opened) {
        if (await aiPlaceCanal(pid, loc, def)) {
          log(`AI ${pid} built a Canal at ${loc.x},${loc.y} (${pr.paid}/${pr.need} production)`);
          delete s.projects[pid]; s.last[pid] = turn; opened = { pid, at: loc };
        } else if (districtAt(loc) === "" && (pr.idle = (pr.idle || 0) + 1) >= 10) {
          log(`AI ${pid}: Canal at ${loc.x},${loc.y} abandoned, the tile not worked for ${pr.idle} turns`);
          delete s.projects[pid]; s.last[pid] = turn;
        } else if (unitsOnTile(loc) === 0 && districtAt(loc) !== "" && (pr.fails = (pr.fails || 0) + 1) >= 3) {
          log(`AI ${pid}: Canal at ${loc.x},${loc.y} abandoned after ${pr.fails} failed placements`);
          delete s.projects[pid]; s.last[pid] = turn;
        }
      }
      continue;
    }
    if (s.last[pid] != null && turn - s.last[pid] < AI_COOLDOWN_TURNS) continue;
    const site = aiCanalSite(pid, def); if (!site) continue;
    if (!opened && await aiBuyCanal(pid, site.city, site.loc, def)) {
      s.last[pid] = turn; opened = { pid, at: site.loc }; continue;
    }
    const need = Number(def.Cost) || 500;
    s.projects[pid] = { plot: idx(site.loc), cityId: site.city.id, type: def.ConstructibleType, need, paid: 0 };
    log(`AI ${pid} started a Canal at ${site.loc.x},${site.loc.y} (${s.projects[pid].need} production)`);
  }
  aiSave(s);
  if (turn % 10 === 0) log(`AI canals turn ${turn}: ${Object.keys(s.projects).length} under way ${J(s.projects)}`);
  return opened;
}

// --- telling the player ------------------------------------------------------------------------------

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
 * session (watched, c99: the hex kept its sea mesh after the retype to land). One save and load draws them as canals
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

// --- install ---------------------------------------------------------------------------------------

function install() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d) { state.canalIndexes.add(d.$index); safe(() => state.canalIndexes.add(GameInfo.Types.lookup(t).Hash)); }
  }
  if (!state.canalIndexes.size) { log("no Canal buildings in the database; inactive"); return false; }
  state.multiplayer = !!safe(() => Configuration.getGame().isNetworkMultiplayer, false);
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
  log(`active${state.multiplayer ? " (network game: canals not offered)" : ""}: Canal placement limited to isthmus tiles`);
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
    version: "1.1.0",
    set enabled(v) { state.enabled = !!v; },
    get enabled() { return state.enabled; },
    uninstall, isIsthmus, eligiblePlots, openCanal, sweep, loadPending, loadOpen,
    drawOverlay, clearOverlay, redrawNeighbours, hasResource,
    aiPlan, aiCanalSite, aiMajors, thisAgesCanal, aiBuyCanal, aiPlaceCanal, aiState, waterAreas, reloadThroughSave,
    get staleLoad() { return state.staleLoad.slice(); },
    channelArms: (loc) => ({ water: waterSideIndexes(loc), arms: runArms(runOf(loc)).get(idx(loc)) || [] }),
  };
  install();
}
