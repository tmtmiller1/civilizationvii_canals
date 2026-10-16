// canals-repair.js - Canals, game scope.
//
// The turn-start sweep and the repair of districts without a city. Split out of canals.js (docs/split-plan.md).
"use strict";

import { drawOverlay } from "./canals-look.js";
import { canalOn, districtAt, idx, locOf, occupants, terrainOf } from "./canals-map.js";
import {
  destroyDistrict, districtHolder, localTurnActive, openCanal, owningCity, settleCanalTile
} from "./canals-open.js";
import { isIsthmus, ruleFor } from "./canals-rule.js";
import { coastAgain } from "./canals-save.js";
import {
  CANAL_TYPES, J, ONE_TILE, ONE_TILE_CANAL, ageRank, forget, loadOpen, loadPending, log, safe, sleep, state
} from "./canals-state.js";

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
    // Any other district without a city. Up to 1.4.3 a Canal ordered on a tile without an urban district got one made
    // for it by script, which 1.2.1 and earlier made without a city too; a build that never finished left it on
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
 * takes the order (a district just made takes none for a moment), and moved back to its
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
/** The tile's owner is a major civilization and one of its own cities holds the tile. */
function heldByOwnersCity(owner, city) {
  if (owner < 0 || !city || !safe(() => Players.get(owner).isMajor, false)) return false;
  return safe(() => Cities.get(city).owner, -1) === owner;
}
/**
 * An open canal missing its district or its Canal building: an opening cut short (the turn ended part-way, so the
 * requests after it never landed), or anything else that took them off. The tile is settled again as an opening
 * leaves it: a rural district held by the city that owns the tile, the Canal of its own kind, the site marker. The
 * citizen an opening places is not given again: one cut short has already freed it, for the player to place.
 */
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

export { queuedHere, repairCitylessDistricts, sweep };
