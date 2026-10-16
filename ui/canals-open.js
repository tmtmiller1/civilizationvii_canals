// canals-open.js - Canals, game scope.
//
// Opening a finished Canal: the retype, the rural tile, the district helpers. Split out of canals.js (docs/split-
// plan.md).
"use strict";

import { drawOverlay, hideWorks, redrawNeighbours, showWorks } from "./canals-look.js";
import {
  canalOn, cliffSideIndexes, districtAt, districtIdAt, featureOf, idx, isImprovement, occupants, terrainOf
} from "./canals-map.js";
import { isObsolete } from "./canals-placement.js";
import { isIsthmus, ruleFor } from "./canals-rule.js";
import { rememberOpen } from "./canals-save.js";
import { markCanalTile } from "./canals-sites.js";
import {
  ONE_TILE, ONE_TILE_CANAL, forget, loadOpen, log, safe, saveInFlight, sleep, state, withBlock
} from "./canals-state.js";

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

/**
 * The opened tile kept as the rural tile it was: a script-placed improvement on a rural district replaces the one
 * there (engine-closed.md), so the boat takes the farm's place. False when the boat did not land, and the opening
 * falls back to rebuilding the tile.
 */
async function keepRuralTile(loc, who) {
  const BOAT = "IMPROVEMENT_FISHING_BOAT";
  const local = GameContext.localPlayerID;
  const others = () => occupants(loc).filter((o) => isImprovement(o.type) && o.type !== BOAT);
  // the land improvement first, and gone before the boat is placed: a placed improvement takes the place (and can
  // take the id) of the one there, and a destroy sent for the old one then took the boat (wm4)
  for (const o of others())
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
  for (let k = 0; k < 20 && others().length; k++) await sleep(100);
  if (!occupants(loc).some((o) => o.type === BOAT)) {
    safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT",
      { Kind: "CONSTRUCTIBLE", Type: BOAT, Location: { x: loc.x, y: loc.y }, Owner: who }));
    for (let k = 0; k < 20 && !occupants(loc).some((o) => o.type === BOAT); k++) await sleep(100);
  }
  if (!occupants(loc).some((o) => o.type === BOAT)) { log(`canal at ${loc.x},${loc.y}: no boat landed on the rural tile; rebuilt`); return false; }
  await markCanalTile(loc);
  return !!canalOn(loc);
}

/**
 * A Canal has completed on `loc`: make it a canal. Owner may be any player; the local client does the work
 * (single player only, see the multiplayer note above).
 */
async function openCanal(loc, owner) {
  const plot = idx(loc);
  if (state.busy.has(plot) || state.hold) return; // held: the next sweep opens it (see keeping the land look)
  if (notThisTurn(loc)) return;
  state.busy.add(plot);
  try { await openSite(loc, owner, plot); } finally { state.busy.delete(plot); hideWorks(loc); }
}

/** The opening itself, the tile held busy (openCanal). */
async function openSite(loc, owner, plot) {
  if (canalOn(loc) && !loadOpen().some((e) => e.plot === plot)) showWorks(loc);
  const canal = canalOn(loc);
  if (!canal || !canal.complete) return;
  const ready = readyToOpen(loc, plot, canal);
  if (!ready) return;
  const site = siteBefore(loc, owner, canal, ready.alreadyWater);
  const flipped = ready.alreadyWater || await flipToCoast(loc);
  if (!flipped) { log(`Canal at ${loc.x},${loc.y}: terrain did not change; left as a building`); return; }
  const look = recordAndDraw(loc, plot, site);
  // The engine places the Canal on the district the tile has (cm2, 2026-10-08). On a rural one the Canal already
  // stands where the finished canal keeps it: the land improvement gives way to the boat and that is all.
  if (districtAt(loc) === "DISTRICT_RURAL" && await keepRuralTile(loc, site.who)) {
    forget(plot);
    log(`canal opened at ${loc.x},${loc.y} for player ${site.who} on its rural tile: ${occupants(loc).map((o) => o.type).join(",")} overlay=${look.drawn} neighboursRedrawn=${look.redrawn}`);
    return;
  }
  await rebuildAsRural(loc, plot, canal, site, look);
}

/** Whether the finished Canal is to be opened now; { alreadyWater } when it is. */
function readyToOpen(loc, plot, canal) {
  const onRecord = loadOpen().some((e) => e.plot === plot);
  // Coast already: an open canal (the Canal building stays on the finished tile), or a flip that landed after its
  // wait ran out, which left a Coast tile with an urban Canal and no record; that one is taken up from here.
  const alreadyWater = terrainOf(loc) === "TERRAIN_COAST";
  if (alreadyWater && onRecord) return null;
  if (state.saving || onRecord) return null; // an open canal, land only while a save runs
  if (alreadyWater) log(`Canal at ${loc.x},${loc.y}: water already, no record; opened from here`);
  // Buildings of the age share the tile only on an AI's or a stale tile; obsolete ones the canal replaces (c14).
  const shared = occupants(loc).some((o) => o.type !== canal.type && !isImprovement(o.type) && !isObsolete(o.type));
  if (shared || !isIsthmus(loc, ruleFor(canal.type))) {
    log(`Canal at ${loc.x},${loc.y} ${shared ? "shares its tile with other buildings" : "is not on a canal site"}; left as a building`);
    forget(plot); return null;
  }
  return { alreadyWater };
}

/** What the opening needs from the tile as it was: the owner, its city, the cliffs, the land and the canal's age. */
function siteBefore(loc, owner, canal, alreadyWater) {
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
  return { who, local, cityId, cliffSides, landType, age };
}

/** On record and drawn, the moment the tile is water. */
function recordAndDraw(loc, plot, site) {
  // On record the moment it is water. The rest of this is seconds of engine requests; a save that starts in that
  // time lands this canal with the others (wrapSaveGame) and the load knows it as a canal, not as open sea with
  // no record of its own.
  rememberOpen(plot, site.age, site.cliffSides, site.landType);
  // Drawn now, not once the tile is settled: the steps below each redraw the hex (the houses go, the plot changes
  // hands, the rural district, the boat and the Canal land one by one), and with the canal look already over it
  // they happen under the art rather than in front of a bare hex. The look is a model group of its own, so the
  // engine's redraws do not touch it; the houses hide it only until they are taken off, a moment later.
  state.openedHere.add(plot); state.landMesh.add(plot);
  const drawn = drawOverlay(loc, site.age, site.cliffSides);
  const redrawn = redrawNeighbours(loc);
  return { drawn, redrawn };
}

/** The tile rebuilt as a worked rural fishing tile holding the Canal. */
async function rebuildAsRural(loc, plot, canal, site, look) {
  const { who, local, cityId } = site;
  // An urban district (the engine's construction site for a production build on a bare city tile, or a quarter
  // whose obsolete buildings the canal replaces) draws a block of houses over the hex, which hides the canal (run
  // c14): the Canal and the district go. The citizen the Canal housed comes back as a pending point and is placed
  // on the finished canal with the game's own expand order, which makes it a worked rural fishing tile (c23); the
  // invisible works building of the canal's age then adds its food and gold to the city natively.
  for (const o of occupants(loc)) if (o.type !== canal.type && !isImprovement(o.type))
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
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
  log(`canal opened at ${loc.x},${loc.y} for player ${who}: ${terrainOf(loc)} district=${districtAt(loc) || "none"} owner=${safe(() => GameplayMap.getOwner(loc.x, loc.y))} overlay=${look.drawn} neighboursRedrawn=${look.redrawn}`);
}


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

/** The citizen the Canal housed, placed on the finished tile with the city's own expand order (settleCanalTile). */
async function placeCitizen(loc, cityId, plot, city) {
  safe(() => city.addRuralPopulation(1));
  await sleep(1500);
  const can = safe(() => Game.CityCommands.canStart(cityId, CityCommandTypes.EXPAND, {}, false), null);
  const plots = (can && can.Plots) || [];
  const k = plots.indexOf(plot);
  if (k < 0) return;
  const args = { X: loc.x, Y: loc.y };
  if (can.ConstructibleTypes && can.ConstructibleTypes[k] != null)
    args.ConstructibleType = can.ConstructibleTypes[k];
  safe(() => Game.CityCommands.sendRequest(cityId, CityCommandTypes.EXPAND, args));
  for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100);
}

/**
 * The finished canal tile: the citizen the Canal housed is placed on it with the city's own expand order (rural
 * district, fishing boats, a worker: c23), then the age's invisible works building is created there. If the
 * expand order does not offer the tile, a rural district is created directly and the citizen stays pending for the
 * player to place.
 */
async function settleCanalTile(loc, cityId, owner, canalType, opts) {
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  if (cityId && owner === local && !(opts && opts.repair)) {
    const city = safe(() => Cities.get(cityId), null);
    if (city) await placeCitizen(loc, cityId, plot, city);
  }
  if (districtAt(loc) === "" && !(await createRuralDistrict(loc, cityId, owner))) return;
  if (!occupants(loc).some((o) => o.type === canalType)) { safe(() => Game.PlayerOperations.sendRequest(local, "CREATE_ELEMENT", { Kind: "CONSTRUCTIBLE", Type: canalType, Location: { x: loc.x, y: loc.y }, Owner: owner })); await sleep(1500); }
  // The Canal requires the site marker on its tile: the opened tile keeps one under its Canal, as the engine expects
  // of any tile that holds the building. Put last, so neither the fishing boat nor the Canal has to be placed over it.
  await markCanalTile(loc);
}

export {
  createRuralDistrict, destroyDistrict, districtHolder, localTurnActive, openCanal, owningCity, settleCanalTile
};
