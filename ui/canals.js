// canals.js - Canals, a Civilization VII mod. Game scope.
//
// What it does (every step watched 2026-09-25 on 1.5.0, see docs/verification-runs.md):
//   1. Placement. The Canal buildings (data/canals.xml) carry no terrain rule of their own; this script decides
//      where they may go by wrapping Game.CityOperations.canStart: for a Canal, the offered plots are the city's
//      land tiles with water on at least two separate sides (a strip of land between coasts, the same sea or
//      not), and the per-plot check refuses anything else.
//   2. Commit. A Canal BUILD on an isthmus without an urban district first gets one (CREATE_ELEMENT DISTRICT), then
//      the BUILD is forwarded; if the engine refuses the build the district is removed again. The tile is
//      remembered in the save (GameConfiguration key) so a reload mid-construction still finishes the job.
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
/** Water a ship can sail: sea, lake, or a navigable river tile (which the engine's water flag does not cover); a
 * settlement center counts as a canal end too. */
function isShipWater(loc) { return ((isWater(loc) || safe(() => GameplayMap.isNavigableRiver(loc.x, loc.y), false)) && featureOf(loc) !== "FEATURE_ICE") || isSettlementCentre(loc); }

/**
 * How many separate stretches of water sit around the hex: walking the six neighbors in ring order, a run of
 * water tiles (ice not counted) is one stretch. Two stretches means the tile is a strip of land between two
 * coasts, whether or not those coasts belong to the same sea: three coast tiles on one side and one on the other
 * is two stretches; five coast tiles in a row (a headland) is one.
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
  const ring = RING.map((d) => openWaterSide(loc, d));
  let runs = 0;
  for (let i = 0; i < 6; i++) if (ring[i] && !ring[(i + 5) % 6]) runs++;
  if (runs === 0 && ring.every(Boolean)) return 1;
  return runs;
}

/** Land a canal can be cut through: flat or hill, not a navigable river tile. */
function isCuttable(loc) {
  if (isWater(loc)) return false;
  const tt = terrainOf(loc);
  if (tt !== "TERRAIN_FLAT" && tt !== "TERRAIN_HILL") return false;
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
function rememberOpen(plot, age, cliffs) {
  const l = loadOpen();
  if (!l.some((e) => e.plot === plot)) {
    l.push({ plot, age, cliffs: cliffs || [] });
    safe(() => Configuration.editGame().setValue(OPEN_KEY, JSON.stringify(l)));
  }
}

// --- the canal itself -----------------------------------------------------------------------------

const state = {
  enabled: true, originals: null, canalIndexes: new Set(), busy: new Set(),
  multiplayer: false, paidTurn: -1, transits: new Map(), transitTurn: -1
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
  if (state.busy.has(plot)) return;
  state.busy.add(plot);
  try {
    const canal = canalOn(loc);
    if (!canal || !canal.complete) return;
    if (terrainOf(loc) === "TERRAIN_COAST") return; // already a canal (the Canal building stays on the finished tile)
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
    rememberOpen(plot, age, cliffSides);
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

/**
 * The order the arms are drawn in: first the arm whose left-hand sector (the next ring direction) is dry land, so
 * the props and the house layout, which sit to the left of the first arm, never stand in another channel.
 */
function orderSides(sides) {
  if (sides.length < 2) return sides;
  // "left" of an arm (alongArm's +y) is counter-clockwise on screen, which is the PREVIOUS ring index
  // (armAngle turns counter-clockwise as the index falls); watched c32: the props sat on the next arm with +1.
  const k = sides.findIndex((i) => !sides.includes((i + 5) % 6));
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
 * Watched 2026-09-25 (runs c29, c30): further out than 0.42 the chamber vanishes into the cliff mesh.
 */
const LOCK_PIECES = [
  ["IMP_Saqiya_Canal_Decal_Straight_A", 0.42, 0, 1, 0],
  ["MED_CRT_Dockyard_Gate_HB", 0.42, 0.17, 0.5, 0],
  ["NEU_NOR_Gristmill_WaterWheel", 0.36, -0.16, 0.5, 0],
  // water spilling over the cliff foot beyond the lock: the looping fall effect, just past the edge and half a unit up
  // (watched c34: at the edge itself or lower it shows nothing)
  ["VFX_WaterFall_Loop_AutoHeight_Medium", 0.55, 0, 1, 0, 0.5],
];

function drawOverlay(loc, age, cliffs) {
  const plot = idx(loc);
  if (overlays.has(plot) || typeof WorldUI === "undefined" || typeof PlacementMode === "undefined") return false;
  const sides = orderSides(waterSideIndexes(loc));
  if (!sides.length) return false;
  const looks = AGE_LOOKS[age] || AGE_LOOKS.AGE_ANTIQUITY;
  const look = looks[plot % looks.length];
  const group = safe(() => WorldUI.createModelGroup("Canals_" + plot), null);
  if (!group) return false;
  const P = (scale, angle) => ({
    placement: PlacementMode.TERRAIN, followTerrain: true, needsShadows: true, scale, angle
  });
  const plotRef = { i: loc.x, j: loc.y };
  const a0 = armAngle(sides[0]);
  const add = (asset, off, scale, angle) => safe(
    () => group.addModelAtPlot(asset, plotRef, off || { x: 0, y: 0, z: 0 }, P(scale, angle))
  );
  // The house layout is a corridor between two shores; a junction of three or more channels gets none.
  if (look.layout && sides.length <= 2) {
    const L = layoutFor(sides); add(L, null, 1, a0);
    if (look.attachments) add(L + look.attachments, null, 1, a0);
    if (look.decal) add(L + look.decal, null, 1, a0);
  }
  for (const i of sides) add(ARM_ASSET, null, 1, armAngle(i));
  if (cliffs && cliffs.length) for (const i of sides) if (cliffs.includes(i))
    for (const [asset, x, y, scale, rot, z] of LOCK_PIECES) {
      const off = alongArm(armAngle(i), x, y); off.z = z || 0;
      add(asset, off, scale, (armAngle(i) + rot) % 360);
    }
  for (const [asset, x, y, scale] of look.props) add(asset, alongArm(a0, x, y), scale, a0);
  // Boats on the tiles that meet open water or a junction; a straight middle reach of a longer canal stays clear.
  if (sides.length !== 2 || (sides[1] - sides[0] + 6) % 6 !== 3 || plot % 2 === 0) add(BOATS_ASSET, null, 0.7, a0);
  overlays.set(plot, group);
  return true;
}

function clearOverlay(loc) {
  const g = overlays.get(idx(loc));
  if (g) { safe(() => g.clear()); safe(() => g.destroy()); overlays.delete(idx(loc)); }
}

/** A canal that has just opened is water now: the opened canals beside it are redrawn so their channels meet it. */
function redrawNeighbours(loc) {
  const open = new Map(loadOpen().map((e) => [e.plot, e]));
  let n = 0;
  for (const nb of neighbors(loc)) {
    const p = idx(nb);
    if (!open.has(p) || terrainOf(nb) !== "TERRAIN_COAST") continue;
    clearOverlay(nb);
    if (drawOverlay(nb, open.get(p).age, open.get(p).cliffs)) n++;
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

/** Re-check every remembered site and every complete Canal on the map (missed events, reloads, AI canals). */
function sweep() {
  if (!state.enabled || state.multiplayer) return;
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
    if (c && c.complete && terrainOf(loc) !== "TERRAIN_COAST" && isIsthmus(loc)) openCanal(loc, c.owner);
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
    if (!isIsthmus(loc)) continue;
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

function wrapCanStart(oCan) {
  return function (cityID, type, args, ...rest) {
    const res = oCan(cityID, type, args, ...rest);
    if (!state.enabled || type !== CityOperationTypes.BUILD || !args || !canalIndex(args.ConstructibleType)) return res;
    if (state.multiplayer) return { ...res, Success: false, Plots: [], FailureReasons: ["LOC_CANAL_NOT_ISTHMUS"] };
    const loc = plotOf(args);
    if (loc) {
      if (!isIsthmus(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_NOT_ISTHMUS"] };
      return { ...res, Success: true, FailureReasons: [] };
    }
    const plots = eligiblePlots(cityID);
    // Keep the engine's own verdict on WHETHER the Canal may be built (locked, already queued); decide only WHERE.
    const engineSaysNo = !res || (res.Success === false && !(res.FailureReasons || []).includes("LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION") && !(res.Plots || []).length && (res.FailureReasons || []).length);
    if (engineSaysNo) return { ...res, Plots: [] };
    return { ...res, Plots: plots, Success: plots.length > 0, FailureReasons: plots.length ? [] : ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
  };
}

/** A Canal BUILD on a tile without an urban district: create one, then forward; undo the district on refusal. */
async function districtThenBuild(cityID, loc, ctype, forward) {
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  const hadDistrict = districtAt(loc) === "DISTRICT_URBAN";
  const oCan = state.originals && state.originals.canStart;
  const engineAccepts = () => safe(() => {
    const r = oCan.call(Game.CityOperations, cityID, CityOperationTypes.BUILD,
      { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false);
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
  for (let k = 0; k < 50 && !engineAccepts(); k++) await sleep(100);
  if (!engineAccepts()) log(`engine verdict on the Canal at ${loc.x},${loc.y}: ${J(safe(() => oCan.call(Game.CityOperations, cityID, CityOperationTypes.BUILD, { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false), null))}`);
  remember(plot);
  forward();
  const t0 = Date.now();
  while (Date.now() - t0 < BUILD_LAND_MS) { await sleep(100); if (canalOn(loc)) { log(`Canal queued at ${loc.x},${loc.y}`); return; } }
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

function wrapSendRequest(oSend) {
  return function (cityID, type, args, ...rest) {
    if (!state.enabled || state.multiplayer || type !== CityOperationTypes.BUILD || !args
      || !canalIndex(args.ConstructibleType)) return oSend(cityID, type, args, ...rest);
    const loc = plotOf(args);
    if (!loc || !isIsthmus(loc)) return oSend(cityID, type, args, ...rest);
    districtThenBuild(cityID, loc, args.ConstructibleType, () => oSend(cityID, type, args, ...rest));
    return true;
  };
}

// --- install ---------------------------------------------------------------------------------------

function install() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d) { state.canalIndexes.add(d.$index); safe(() => state.canalIndexes.add(GameInfo.Types.lookup(t).Hash)); }
  }
  if (!state.canalIndexes.size) { log("no Canal buildings in the database; inactive"); return false; }
  state.multiplayer = !!safe(() => Configuration.getGame().isNetworkMultiplayer, false);
  const host = safe(() => Game.CityOperations, null);
  if (!host || typeof host.canStart !== "function" || typeof host.sendRequest !== "function") { log("Game.CityOperations not wrappable; inactive"); return false; }
  state.originals = { canStart: host.canStart, sendRequest: host.sendRequest };
  host.canStart = wrapCanStart(host.canStart.bind(host));
  host.sendRequest = wrapSendRequest(host.sendRequest.bind(host));
  safe(() => engine.on("ConstructibleBuildCompleted", onBuildCompleted));
  safe(() => engine.on("PlayerTurnActivated", (d) => { if (d && (d.player ?? d.Player) === GameContext.localPlayerID) setTimeout(sweep, SETTLE_MS); }));
  const uhost = safe(() => Game.UnitOperations, null);
  if (uhost && typeof uhost.sendRequest === "function") { state.originals.unitSend = uhost.sendRequest; uhost.sendRequest = wrapUnitSend(uhost.sendRequest.bind(uhost)); }
  setTimeout(sweep, 5000);
  log(`active${state.multiplayer ? " (network game: canals not offered)" : ""}: Canal placement limited to isthmus tiles`);
  return true;
}

function uninstall() {
  const host = safe(() => Game.CityOperations, null);
  if (host && state.originals) {
    host.canStart = state.originals.canStart; host.sendRequest = state.originals.sendRequest;
  }
  const uhost = safe(() => Game.UnitOperations, null);
  if (uhost && state.originals && state.originals.unitSend) uhost.sendRequest = state.originals.unitSend;
  state.enabled = false;
  log("uninstalled");
}

if (!G[KEY]) {
  G[KEY] = {
    version: "1.0.0",
    set enabled(v) { state.enabled = !!v; },
    get enabled() { return state.enabled; },
    uninstall, isIsthmus, eligiblePlots, openCanal, sweep, loadPending, loadOpen,
    drawOverlay, clearOverlay, redrawNeighbours,
  };
  install();
}
