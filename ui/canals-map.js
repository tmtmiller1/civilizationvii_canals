// canals-map.js - Canals, game scope.
//
// Map reads and the water helpers. Split out of canals.js (docs/split-plan.md).
"use strict";

import { SITE_FEATURES } from "./canals-sites.js";
import { CANAL_TYPES, G, safe } from "./canals-state.js";

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
function neighborIn(loc, d) {
  const n = safe(() => GameplayMap.getAdjacentPlotLocation(loc, DirectionTypes[d]), null);
  return n && n.x >= 0 ? { x: n.x, y: n.y } : null;
}

/**
 * How many separate ways a ship can reach the hex: walking the six neighbors in ring order, a run of open water
 * (ice not counted) is one way in, and a settlement center beside the tile is one of its own. Two ways in means
 * the tile is a strip of land between two shores, whether or not those shores belong to the same sea: three coast
 * tiles on one side and one on the other is two; five coast tiles in a row (a headland) is one.
 * A center is counted apart from the water rather than as a piece of it. Counted as water it could bridge the gap
 * between a neck's two shores and read them as a single stretch, so founding a settlement next to a neck took the
 * neck's own site away (c48: a Modern town beside a two-shore neck left it unbuildable).
 */
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
 * urban tile on the whole map held a resource). The Canal is a building, so such a tile is never offered. A script
 * can clear the resource first (WorldBuilder.MapPlots.setResource(-1, loc, 0), mep1), but the player would lose it.
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

export {
  RING, areaOf, canalOn, clearableFeature, cliffSideIndexes, currentAge, districtAt, districtIdAt, featureOf,
  hasResource, idx, isCuttable, isImprovement, isOpenWater, isParkland, isSettlementCentre, isShipWater, isWater,
  locOf, neighborIn, neighbors, occupants, openWaterSide, terrainOf, waterAreas, waterStretches
};
