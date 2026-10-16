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
  if (repairWaits()) return;
  state.repairing = true;
  try {
    // awaited only when there's a canal to repair, so a sweep with none runs straight through as it always has
    if (loadOpen().some((e) => brokenCanal(e, locOf(e.plot), districtHolder(locOf(e.plot))))
      && !(await repairOpenCanals())) return;
    // Any other district without a city. Up to 1.4.3 a Canal ordered on a tile without an urban district got one made
    // for it by script, which 1.2.1 and earlier made without a city too; a build that never finished left it on
    // the land for good, off the pending list, and buildings later put there gave the city nothing (a player's save,
    // 2026-10-01). Pending tiles are read at every sweep. The rest of the map is read until one whole pass has gone
    // through cleanly, then never again for this game: from 1.2.2 the mod makes no district without a city, so only a
    // game begun with an older Canals has any, and the pass is recorded in the game (a save carries it).
    const open = new Set(loadOpen().map((e) => e.plot));
    const heal = (plot) => healCityless(plot, open);
    for (const plot of loadPending()) {
      if (state.saving || state.hold) return;
      await heal(plot);
    }
    if (mapChecked()) return;
    await healMap(heal);
  } finally { state.repairing = false; }
}

/** Off, a network game, a save or a load under way, retypes held, or a repair already running. */
function repairWaits() {
  return !state.enabled || state.multiplayer || state.saving || state.loading || state.hold || state.repairing;
}

/** Each opened canal whole again (repairCitylessDistricts). False when the pass is cut short. */
async function repairOpenCanals() {
  for (const e of loadOpen()) {
    if (state.saving || state.hold) return false;
    const loc = locOf(e.plot); const h = districtHolder(loc);
    if (!brokenCanal(e, loc, h)) continue;
    if (!localTurnActive()) return false; // the requests would not land; the next turn's sweep comes back
    state.busy.add(e.plot);
    try {
      if (h && !h.city) await repairCanalTile(loc, e.age);
      else await healCanalTile(loc, e);
    } finally { state.busy.delete(e.plot); }
  }
  return true;
}

/** An opened canal, not busy and water, missing its district's city or its Canal. */
function brokenCanal(e, loc, h) {
  if (state.busy.has(e.plot) || terrainOf(loc) !== "TERRAIN_COAST") return false;
  return !(h && h.city && canalOn(loc)); // whole
}

/** One plot's district without a city given to its city, unless it's an opened canal or busy. True when nothing
 * was left undone. */
async function healCityless(plot, open) {
  if (open.has(plot) || state.busy.has(plot)) return true;
  const loc = locOf(plot);
  if (!HEALED_DISTRICTS.includes(districtAt(loc))) return true;
  const h = districtHolder(loc);
  if (!h || h.city) return true;
  state.busy.add(plot);
  try { return await healDistrict(loc); } finally { state.busy.delete(plot); }
}

/** The whole map read once; recorded in the game when the pass went through cleanly. */
async function healMap(heal) {
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
    logOnce("heal " + at, `${type} at ${at} belongs to no city and none of its owner's cities holds the tile; left as it is`);
    return true;
  }
  const h = { loc, at, type, owner, city, ownerOf, ...whatStood(loc, owner, city) };
  if (!(await districtAgain(h))) return false;
  await buildingsBack(h);
  return true;
}

/** Log a line once a session. */
function logOnce(key, line) {
  if (state.told.has(key)) return;
  state.told.add(key); log(line);
}

/** What stood on a district to be healed: the finished buildings to put back, the unfinished ones, the queue. */
function whatStood(loc, owner, city) {
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
  return { keep, dropped, queued };
}

/** The district taken off, the plot bought back, and the district made again with the city as Parent. */
async function districtAgain(h) {
  const { loc, at, type, owner, city, ownerOf } = h;
  if (!(await destroyDistrict(loc))) { log(`${type} at ${at} without a city COULD NOT be removed`); return false; }
  if (ownerOf() !== owner) {
    safe(() => Cities.get(city).purchasePlot({ x: loc.x, y: loc.y }));
    for (let i = 0; i < 40 && ownerOf() !== owner; i++) await sleep(100);
  }
  safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
    { Kind: "DISTRICT", Type: type, Location: { x: loc.x, y: loc.y }, Parent: city, Owner: owner }));
  for (let i = 0; i < 30 && districtAt(loc) === ""; i++) await sleep(100);
  return heldAgain(h);
}

/** The made-again district is held by the city; if not, it's taken off again and the loss logged. */
async function heldAgain(h) {
  const { loc, at, type, keep } = h;
  const after = districtHolder(loc);
  if (after && after.city) return true;
  if (after) await destroyDistrict(loc);
  log(`${type} at ${at} rebuilt for its city: ${after ? "STILL NO CITY, removed" : "did not land"}; lost ${keep.join(",") || "nothing"}`);
  return false;
}

/** The finished buildings made again on the healed district, and the player's orders for the tile sent again. */
async function buildingsBack(h) {
  const { loc, at, type, owner, city, keep, dropped, queued } = h;
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
  const ops = queueOps(city, loc, q);
  const stale = ops.has();
  if (stale) {
    ops.send({ InsertMode: CityOperationsParametersValues.RemoveAt, QueueLocation: stale.at });
    for (let i = 0; i < 20 && ops.has(); i++) await sleep(100);
  }
  const ctype = safe(() => GameInfo.Constructibles.lookup(q.type).$index, -1);
  const order = { ConstructibleType: ctype, X: loc.x, Y: loc.y };
  for (let i = 0; i < 60 && !ops.ok(order); i++) await sleep(100);
  if (!ops.send(order)) {
    const why = safe(() => ops.host.canStart(city, ops.BUILD, order, false).FailureReasons, null);
    log(`${q.type} on ${loc.x},${loc.y} not ordered again: ${J(why) || "refused"}`);
    return false;
  }
  return movedBack(ops, q);
}

/** The production host's calls for one queued item (requeue): may it be ordered, order it, its place in the queue. */
function queueOps(city, loc, q) {
  const host = Game.CityOperations; const BUILD = CityOperationTypes.BUILD;
  const ok = (args) => !!safe(() => host.canStart(city, BUILD, args, false).Success, false);
  const send = (args) => ok(args) && (safe(() => host.sendRequest(city, BUILD, args)), true);
  const has = () => queuedHere(city, loc).find((x) => x.type === q.type);
  return { host, BUILD, ok, send, has };
}

/** The order ordered again, moved back to the place in the queue it had. */
async function movedBack(ops, q) {
  for (let i = 0; i < 20 && !ops.has(); i++) await sleep(100);
  const now = ops.has();
  if (!now) return false;
  const move = CityOperationsParametersValues.MoveTo;
  if (q.at >= 0 && now.at !== q.at)
    ops.send({ InsertMode: move, QueueSourceLocation: now.at, QueueDestinationLocation: q.at });
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
    logOnce("heal " + at, `canal at ${at} is missing its district or Canal, and no city of its owner holds the tile; left as it is`);
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
  const canalType = canalTypeOf(loc, age);
  if (!(await destroyDistrict(loc))) { log(`canal at ${loc.x},${loc.y}: district without a city COULD NOT be removed`); return; }
  const settle = city && owner >= 0;
  if (settle && ownerOf() !== owner) {
    safe(() => Cities.get(city).purchasePlot({ x: loc.x, y: loc.y }));
    for (let i = 0; i < 40 && ownerOf() !== owner; i++) await sleep(100);
  }
  if (settle) await settleCanalTile(loc, city, owner, canalType, { repair: true });
  log(`canal at ${loc.x},${loc.y}: district without a city rebuilt for player ${owner}: ${holderNote(loc)}; ` +
    `${occupants(loc).map((o) => o.type).join(",") || "nothing on it"}`);
}

/** The Canal on the tile, or the one of the canal's age. */
function canalTypeOf(loc, age) { return (canalOn(loc) || {}).type || CANAL_OF_AGE[age] || CANAL_TYPES[0]; }

/** Who holds the tile's district now, for the log. */
function holderNote(loc) {
  const after = districtHolder(loc);
  return after ? (after.city ? "held by its city" : "STILL NO CITY") : "no district";
}

/** Re-check every remembered site and every complete Canal on the map (missed events, reloads, AI canals). */
function sweep() {
  if (!state.enabled || state.multiplayer || state.saving || state.loading) return;
  const restored = coastAgain().length;
  if (restored) log(`turn start: ${restored} canal tile(s) back to Coast`);
  const opened = new Set(loadOpen().map((e) => e.plot));
  for (const e of loadOpen()) { const loc = locOf(e.plot); if (terrainOf(loc) === "TERRAIN_COAST") drawOverlay(loc, e.age, e.cliffs); }
  const seen = openPending();
  openFinished(seen, opened);
  repairCitylessDistricts();
}

/** Each remembered site: forgotten when its Canal is gone, opened when it's finished. Returns the plots read. */
function openPending() {
  const seen = new Set();
  for (const plot of loadPending()) {
    const loc = locOf(plot); seen.add(plot);
    const c = canalOn(loc);
    if (!c) { if (terrainOf(loc) === "TERRAIN_COAST" || districtAt(loc) === "") forget(plot); continue; }
    if (c.complete) openCanal(loc, c.owner);
  }
  return seen;
}

/** Every other finished Canal on the map that isn't open yet (an AI's, or a missed event) opened if on a site. */
function openFinished(seen, opened) {
  const W = safe(() => GameplayMap.getGridWidth(), 0), H = safe(() => GameplayMap.getGridHeight(), 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const loc = { x, y }; const plot = idx(loc);
    if (seen.has(plot)) continue;
    const c = canalOn(loc);
    if (!c || !c.complete || opened.has(plot) || terrainOf(loc) === "TERRAIN_COAST") continue;
    if (isIsthmus(loc, ruleFor(c.type))) openCanal(loc, c.owner);
  }
}

export { queuedHere, repairCitylessDistricts, sweep };
