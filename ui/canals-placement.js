// canals-placement.js - Canals, game scope.
//
// Placement and commit: the engine's plots, the canStart, canStartQuery and sendRequest wraps, placeCanal. Split out of
// canals.js (docs/split-plan.md).
"use strict";

import { hideWorks, showWorks } from "./canals-look.js";
import {
  canalOn, currentAge, districtAt, hasResource, idx, isImprovement, isParkland, locOf, occupants
} from "./canals-map.js";
import { createRuralDistrict, destroyDistrict, openCanal } from "./canals-open.js";
import { queuedHere } from "./canals-repair.js";
import { isIsthmus } from "./canals-rule.js";
import { aiSites, loadSites, markSite, markerFor, unmarkSite } from "./canals-sites.js";
import {
  AGE_RANK, BUILD_RADIUS, CANAL_TYPES, J, ONE_TILE_CANAL, PLACE_MS, SETTLE_MS, ageRank, canalIndex, forget, loadOpen,
  loadPending, log, oneTileMode, remember, safe, sleep, state
} from "./canals-state.js";

// placement and commit

function plotOf(args) { return args && args.X != null && args.Y != null ? { x: args.X, y: args.Y } : null; }

// GameInfo tables have find, filter, forEach and for...of, but no some, every or map: a call to one of those
// throws, and under safe() every building read as untagged. Read once, the way the game's utilities-tags.js does.
let typeTags = null;
function hasTag(type, tag) {
  if (!typeTags) {
    const read = new Map();
    for (const r of safe(() => GameInfo.TypeTags, []) || []) {
      const t = String(r.Type);
      if (!read.has(t)) read.set(t, new Set());
      read.get(t).add(String(r.Tag));
    }
    if (!read.size) return false;
    typeTags = read;
  }
  return typeTags.has(String(type)) && typeTags.get(String(type)).has(tag);
}
/** Dams' Dam buildings, kept like ageless ones: the Antiquity Dam carries no AGELESS tag. */
function isDam(type) { return /^BUILDING_DAM_/.test(String(type)); }
/** A building of an earlier age that is not ageless and not a Dam: one the canal may replace. */
function isObsolete(type) {
  const def = safe(() => GameInfo.Constructibles.lookup(type), null);
  if (!def || !def.Age || isDam(def.ConstructibleType)) return false;
  return (AGE_RANK[String(def.Age)] || 0) < (AGE_RANK[currentAge()] || 0) && !hasTag(def.ConstructibleType, "AGELESS");
}
// Every constructible held to a terrain, biome, feature or resource, read once like the tags above.
let placementRules = null;
function placementRuled() {
  if (placementRules) return placementRules;
  const read = new Set();
  for (const table of ["Constructible_RequiredFeatures", "Constructible_RequiredFeatureClasses", "Constructible_ValidTerrains",
    "Constructible_ValidBiomes", "Constructible_ValidFeatures", "Constructible_ValidResources"])
    for (const r of safe(() => GameInfo[table], []) || []) read.add(String(r.ConstructibleType));
  if (read.size) placementRules = read;
  return read;
}
/** A placement rule in the building's own row: next to a terrain, a district, a river or a lake, or the like. */
function placementColumn(def) {
  return !!(def.AdjacentTerrain || def.AdjacentDistrict || def.RiverPlacement || def.AdjacentLake || def.AdjacentRiver
    || def.RequiresDistantLands || def.RequiresHomeland || def.ExistingDistrictOnly || def.RequiresAppealPlacement);
}
/** A building with no placement rule of its own: the engine's answer for it is where any building may go. */
function plainBuilding(def) {
  if (String(def.ConstructibleClass) !== "BUILDING") return false;
  if (placementColumn(def)) return false;
  if (def.Age && String(def.Age) !== currentAge()) return false;
  const t = String(def.ConstructibleType);
  if (CANAL_TYPES.includes(t)) return false;
  if (placementRuled().has(t)) return false;
  if (safe(() => GameInfo.Buildings.find((b) => String(b.ConstructibleType) === t).TraitType, null)) return false;
  return true;
}
/** The plain buildings of the age, judged once per age: the database doesn't change in a game. */
const plainByAge = new Map();
function plainBuildings() {
  const age = currentAge();
  if (plainByAge.has(age)) return plainByAge.get(age);
  const all = safe(() => [...GameInfo.Constructibles], []);
  const plain = safe(() => all.filter(plainBuilding), []);
  if (all.length) plainByAge.set(age, plain);
  return plain;
}
const engineListCache = new Map();
/**
 * Where the engine lets this settlement put a building right now (urban districts with room, rural tiles it may
 * build onto, obsolete buildings it may replace): its own canStart for a plain building of the age, through the
 * path the Canal is ordered by. A town answers for purchase only, a city for production too (cm2: a town takes a
 * tile it works, never a bare one; a city takes a bare tile and makes the district itself). null when no plain
 * building answers, and the ring rule below stands in.
 */
function enginePlots(cityID, purchase) {
  const host = state.originals && state.originals.hosts[purchase ? 1 : 0];
  if (!host) return null;
  const key = `${J(cityID)}:${purchase ? "buy" : "build"}:${safe(() => Game.turn, 0)}`;
  const hit = engineListCache.get(key);
  if (hit && Date.now() - hit.at < 1000) return hit.plots;
  let plots = null;
  for (const def of plainBuildings()) {
    const ask = () => host.canStart.call(host.host, cityID, host.type, { ConstructibleType: def.$index }, false);
    plots = offeredPlots(safe(ask, null));
    if (plots) break;
  }
  engineListCache.set(key, { at: Date.now(), plots });
  return plots;
}
/** The plots a canStart answer offers the building, or null when it's locked or offers none. */
function offeredPlots(r) {
  if (!r || typeof r !== "object" || r.Locked || (r.NeededUnlock != null && r.NeededUnlock !== -1)) return null;
  const list = (a) => (Array.isArray(a) ? a : []);
  const all = [...list(r.Plots), ...list(r.ExpandUrbanPlots)];
  return all.length ? new Set(all) : null;
}

/**
 * The city's tiles that qualify: a rural tile the settlement works, a bare tile within its build ring (the commit
 * gives it a rural district first, see placeCanal: the Canal is valid on a rural district, so the engine takes it
 * there, in a town as in a city, cm2), or an urban tile where the engine would put a plain building (enginePlots),
 * on a tile that passes the water rule, holds no resource, park or unit, and no building of the age. `anyUnits`
 * keeps a tile a unit stands on (the site marks: a unit passing through must not unmark a site for a turn).
 * `purchase` names the path the Canal is ordered by; without it the ring rule stands in for the engine's list.
 */
function eligiblePlots(cityID, anyUnits = false, purchase = null) {
  const city = safe(() => Cities.get(cityID), null);
  if (!city) return [];
  const s = { centre: safe(() => city.location, null), anyUnits,
    engine: purchase == null ? null : enginePlots(cityID, purchase) };
  // what stands on each tile is read once for both judgements
  return safe(() => city.getPurchasedPlots() || [], [])
    .filter((p) => {
      const loc = locOf(p); const occ = occupants(loc);
      return unfinishedCanal(cityID, loc, occ) || freshSite(p, s, occ);
    });
}

/** The Canal among a tile's occupants, or null (canalOn, from a list already read). */
function canalIn(occ) { return occ.find((o) => CANAL_TYPES.includes(o.type)) || null; }

/** One of the settlement's tiles judged as a new site (see eligiblePlots); `occ` is what stands on it. */
function freshSite(p, s, occ) {
  const loc = locOf(p);
  if (!inBuildReach(p, loc, s)) return false;
  if (!isIsthmus(loc) || hasResource(loc) || isParkland(loc)) return false;
  // a building of the age, or an ageless one, keeps its tile; obsolete ones the canal replaces
  if (occ.some((o) => !isImprovement(o.type) && !isObsolete(o.type))) return false;
  if (canalIn(occ) || loadPending().includes(p)) return false;
  return s.anyUnits || safe(() => (MapUnits.getUnits(loc.x, loc.y) || []).length, 0) <= 0;
}

/** Bare, rural or urban, and within reach: an urban tile where the engine would put a plain building, a rural tile
 * anywhere the settlement holds, a bare one inside its build ring. */
function inBuildReach(p, loc, s) {
  const d = districtAt(loc);
  if (d !== "" && d !== "DISTRICT_RURAL" && d !== "DISTRICT_URBAN") return false;
  if (d === "DISTRICT_URBAN" && s.engine && !s.engine.has(p)) return false;
  const away = () => safe(() => GameplayMap.getPlotDistance(s.centre.x, s.centre.y, loc.x, loc.y), 99);
  return !(d !== "DISTRICT_RURAL" && s.centre && away() > BUILD_RADIUS);
}

/**
 * A Canal begun on this tile and taken out of the queue before it was finished. The engine leaves it on the map with
 * the production put into it, and an order for the same Canal on the same tile takes it up again, progress and all
 * (rs1). The tile now holds a district, a building and a remembered site, so the checks for a fresh site would never
 * offer it again.
 */
function unfinishedCanal(cityID, loc, occ) {
  const c = canalIn(occ);
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

// Each Canal by its constructible index and its type hash, read once: every building check in the game asks this.
let canalKeys = null;
/** The Canal of the age being played. The other two stay in the database so a canal dug in an earlier age is still
 * recognised on the map, but they are never offered. */
function canalDef(type) {
  if (!canalKeys) {
    const keys = new Map();
    for (const t of CANAL_TYPES) {
      const d = safe(() => GameInfo.Constructibles.lookup(t), null);
      if (!d) continue;
      if (!keys.has(d.$index)) keys.set(d.$index, d);
      const h = safe(() => GameInfo.Types.lookup(t).Hash, null);
      if (h != null && !keys.has(h)) keys.set(h, d);
    }
    if (!keys.size) return null;
    canalKeys = keys;
  }
  return canalKeys.get(type) || null;
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
  if (refusedForMore(def, res)) return false;
  const node = unlockNode(def);
  if (!node) return false;
  const needed = neededNode(res);
  if (needed && needed !== node) return false;
  // On a save the mod was added to, the refusal names no tech and gives no reason at all: {Success: false} (c101).
  // Callers pass only this age's Canal, so a refusal with no reason is the missing unlock, not the wrong age.
  if (!needed && !res.Locked && (res.FailureReasons || []).length) return false;
  return !!safe(() => Players.get(pid).Techs.isNodeUnlocked(node), false);
}
/** Nothing to sell: no answer, a yes, or a refusal an unlock wouldn't fix (built, queued, short of gold). */
function refusedForMore(def, res) {
  return !def || !res || !!(res.Success || res.AlreadyExists || res.InQueue || res.InsufficientFunds);
}
/** The tech a refusal names as missing, or null. */
function neededNode(res) {
  if (res.NeededUnlock == null || res.NeededUnlock === -1) return null;
  return safe(() => String(GameInfo.ProgressionTreeNodes.lookup(res.NeededUnlock).ProgressionTreeNodeType), null);
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
 * A Canal purchase its owner cannot pay for. The engine says so only for a tile that is already a site with an urban
 * district (c37); the plot-less verdict the purchase list is built from is a "no suitable location" the mod
 * overrides, so without this a town lists the Canal as buyable with too little gold.
 */
function cannotAfford(cityID, def) {
  const p = modPrice(cityID, def);
  return p.cost > 0 && p.short;
}

/**
 * No other building may stand on an opened canal. The tile is a worked rural tile, so the engine offered it to every
 * building as a place to expand onto, and a player built a Garden on a canal (report, 2026-09-28). It is taken out of
 * every other building's lists, and a request aimed at it is refused. The same goes for the tile of a Canal waiting in
 * the city's queue: the engine offered it to a Bazaar, and the Bazaar bought there kept the finished Canal from
 * opening (ow7).
 */
function keepOffCanals(res, args, cityID) {
  const taken = canalTiles(cityID);
  if (!taken.size || !res || typeof res !== "object") return res;
  const loc = plotOf(args);
  if (loc) return taken.has(idx(loc)) ? { ...res, Success: false, FailureReasons: ["LOC_CANAL_TILE_TAKEN"] } : res;
  const strip = (a) => (Array.isArray(a) ? a.filter((p) => !taken.has(p)) : a);
  return { ...res, Plots: strip(res.Plots), ExpandUrbanPlots: strip(res.ExpandUrbanPlots) };
}
/** The opened canals, and the tiles of the Canals in this city's queue. */
function canalTiles(cityID) {
  const out = queuedCanalTiles(cityID);
  for (const e of loadOpen()) out.add(e.plot);
  return out;
}
/**
 * The tiles of the Canals in the city's build queue, read from the queue each time, so a Canal taken out of it frees
 * its tile at once. The local player's cities only: the AI's placement is the engine's.
 */
function queuedCanalTiles(cityID) {
  const out = new Set();
  if (cityOwner(cityID) !== safe(() => GameContext.localPlayerID, -1)) return out;
  for (const it of safe(() => Cities.get(cityID).BuildQueue.getQueue() || [], [])) {
    const l = it && it.location;
    if (!l || l.x == null || l.x < 0 || !(canalDef(it.constructibleType) || canalDef(it.type))) continue;
    out.add(idx({ x: l.x, y: l.y }));
  }
  return out;
}

/**
 * Wraps a canStart that places a building: Game.CityOperations BUILD (production) or Game.CityCommands PURCHASE
 * (gold; a town's only way to get a building). For a Canal the offered plots are the canal sites and nothing else,
 * the engine's own urban-expansion plots included (c36: a town's purchase offered three plain tiles beside it
 * and refused the site).
 */
function wrapCanStart(oCan, placeType, purchase) {
  return function (cityID, type, args, ...rest) {
    const res = oCan(cityID, type, args, ...rest);
    if (!state.enabled || type !== placeType || !args) return res;
    const def = canalDef(args.ConstructibleType);
    if (!def) return args.ConstructibleType != null ? keepOffCanals(res, args, cityID) : res;
    const refused = refusedCanal(cityID, def, res, args, purchase);
    if (refused) return refused;
    const loc = plotOf(args);
    const general = loc ? oCan(cityID, type, { ConstructibleType: args.ConstructibleType }, ...rest) : res;
    return pricedCanal({ cityID, def, res, general, loc, purchase });
  };
}

/** A Canal refused before the engine is asked about it anywhere: not the mode's, a network game, or not this tile. */
function refusedCanal(cityID, def, res, args, purchase) {
  // Not the mode's Canal: refused outright. The engine alone would offer the one-tile Canal outside its mode, since
  // it has no age and no unlock (and refuse it only for want of a marked site, which this wrapper overrides).
  if (!isOfferedCanal(def)) return { ...res, Success: false, Plots: [], ExpandUrbanPlots: [], FailureReasons: ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
  if (state.multiplayer) return { ...res, Success: false, Plots: [], ExpandUrbanPlots: [], FailureReasons: ["LOC_CANAL_MULTIPLAYER"] };
  const loc = plotOf(args);
  if (!loc) return null;
  if (!isIsthmus(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_NOT_ISTHMUS"] };
  if (hasResource(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_RESOURCE"] };
  if (isParkland(loc)) return { ...res, Success: false, FailureReasons: ["LOC_CANAL_PARKLAND"] };
  if (!eligiblePlots(cityID, true, purchase).includes(idx(loc)))
    return { ...res, Success: false, FailureReasons: ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
  return null;
}

/** The verdict once the engine has answered for the Canal anywhere (`general`): refused, or priced and placed. */
function pricedCanal(v) {
  const { cityID, def, general, purchase } = v;
  let sold = null;
  if (engineSaysNo(general)) {
    if (!purchase || !unlockedByMod(cityOwner(cityID), def, general))
      return { ...general, Plots: [], ExpandUrbanPlots: [] };
    sold = modPrice(cityID, def);
  }
  // a Canal the mod sells itself (see unlockedByMod) reads as unlocked, priced, and short of gold when it is
  const short = sold ? sold.short : purchase && cannotAfford(cityID, def);
  const open = sold ? { Locked: false, NeededUnlock: -1, Cost: sold.cost, InsufficientFunds: sold.short }
    : short ? { InsufficientFunds: true } : {};
  return canalOffer(v, open, short);
}

/** For one tile, yes or short of gold; for the settlement, every site it has. */
function canalOffer(v, open, short) {
  const { cityID, res, loc, purchase } = v;
  if (loc) {
    if (short) return { ...res, ...open, Success: false, FailureReasons: ["LOC_CITY_PURCHASE_INSUFFICIENT_FUNDS"] };
    return { ...res, ...open, Success: true, FailureReasons: [] };
  }
  const plots = eligiblePlots(cityID, false, purchase);
  const ok = plots.length > 0 && !short;
  return { ...res, ...open, Plots: plots, ExpandUrbanPlots: [], MountainPlots: [], Success: ok, FailureReasons: plots.length ? [] : ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
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
      listCanal(res, d, () => safe(() => host.canStart(cityID, placeType,
        { ConstructibleType: d.$index }, false), null));
    }
    return res;
  };
}

/** One Canal's row in a production or purchase list: dropped for the other mode, else given the mod's verdict. */
function listCanal(res, d, verdictOf) {
  if (!isOfferedCanal(d)) {
    // the other mode's Canal is never listed
    const k = res.findIndex((e) => e && e.index === d.$index);
    if (k >= 0) res.splice(k, 1);
    return;
  }
  const verdict = verdictOf();
  if (!verdict) return;
  const entry = res.find((e) => e && e.index === d.$index);
  if (entry) entry.result = verdict;
  // short of gold still lists it, greyed with its price, as the game lists any building it cannot afford
  else if (verdict.Success || (verdict.InsufficientFunds && (verdict.Plots || []).length))
    res.push({ index: d.$index, result: verdict });
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
 * A Canal order on its tile: the site marker goes on first, the engine's own verdict is waited for, any obsolete
 * building on the tile is taken off (the canal takes the whole tile), and the order is forwarded. The engine places
 * the Canal on whatever district the tile has, or makes one itself (cm2, 2026-10-08): nothing is built by script.
 * A purchased Canal lands complete with no completion event (c36), so the commit opens it.
 */
async function placeCanal(cityID, loc, ctype, forward, path) {
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  // A bare tile gets a rural district first, held by the city: the engine then takes the Canal on it as on any
  // worked tile, a town's as a city's, and no urban construction site is ever drawn. (A bare tile left to the engine
  // takes an urban district in a city and is refused in a town: cm2, wm3.)
  const madeDistrict = districtAt(loc) === "";
  if (madeDistrict && !await createRuralDistrict(loc, cityID, cityOwner(cityID))) {
    log(`no district for the Canal at ${loc.x},${loc.y}; not placed`); return;
  }
  const undo = async () => { if (madeDistrict) await destroyDistrict(loc); };
  // the engine takes a Canal only on a marked site (data/canals-sites.xml); a Canal the mod sells itself needs none
  if (path.soldFor == null && !await siteTaken(cityID, loc, ctype, path)) { await undo(); return; }
  const taken = takeOffObsolete(loc, local);
  remember(plot);
  showWorks(loc);
  forward();
  if (await canalLanded(cityID, loc, ctype, path)) return;
  await notTaken(loc, plot, undo, taken);
}

/** Every building of an earlier age on the tile taken off: the canal takes the whole tile. Returns what was taken. */
function takeOffObsolete(loc, local) {
  const taken = [];
  for (const o of occupants(loc)) if (!isImprovement(o.type) && isObsolete(o.type)) {
    taken.push({ type: o.type, owner: o.owner });
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT",
      { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
  }
  return taken;
}

// buildings a Canal order took off
//
// The order takes the tile's earlier-age buildings off before it's forwarded, as the game's own overbuild clears a
// tile when the building is queued (engine-closed.md, pj7). If the engine then never takes the Canal, neither on the
// map nor into the queue, they're made again on the tile: a building made by script on a district comes back
// finished and held by the city (hl2, healDistrict). Once the order is in, it's the game's rule: a Canal taken out
// of the queue later leaves the old building gone, as cancelling any overbuild does.
/** What a Canal order took off, made again on the tile, newest age first. */
async function putBack(loc, taken) {
  const types = taken.slice().sort((a, b) => ageRank(b.type) - ageRank(a.type));
  for (const t of types) {
    safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
      { Kind: "CONSTRUCTIBLE", Type: t.type, Location: { x: loc.x, y: loc.y }, Owner: t.owner }));
    await sleep(300);
  }
  const missing = () => types.filter((t) => !occupants(loc).some((o) => o.type === t.type));
  for (let i = 0; i < 30 && missing().length; i++) await sleep(100);
  const lost = missing().map((t) => t.type);
  log(`put back at ${loc.x},${loc.y} what the Canal order took off: ${types.map((t) => t.type).join(",")}` +
    `${lost.length ? `; NOT put back: ${lost.join(",")}` : ""}`);
}

/** The engine never placed the forwarded Canal: the works off, the order forgotten, the marker and district undone,
 * and what the order took off put back. */
async function notTaken(loc, plot, undo, taken) {
  hideWorks(loc);
  log(`the engine did not take the Canal at ${loc.x},${loc.y}`);
  forget(plot);
  if (plot in loadSites() && !aiSites().has(plot)) await unmarkSite(loc);
  await undo();
  if (taken.length) await putBack(loc, taken);
}

/** The site marker on, and the engine's own yes for the Canal on this tile waited for; false (marker off) if not. */
async function siteTaken(cityID, loc, ctype, path) {
  const plot = idx(loc);
  const ask = () => safe(() => path.oCan.call(path.host, cityID, path.type,
    { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false), null);
  const engineAccepts = () => safe(() => {
    const r = ask();
    return !!(r && r.Success);
  }, false);
  if (!await markSite(loc, markerFor((canalDef(ctype) || {}).ConstructibleType))) log(`the site marker did not land at ${loc.x},${loc.y}`);
  for (let k = 0; k < 20 && !engineAccepts(); k++) await sleep(100);
  if (engineAccepts()) return true;
  log(`the engine refuses the Canal at ${loc.x},${loc.y}: ${J(ask())}`);
  if (plot in loadSites() && !aiSites().has(plot)) await unmarkSite(loc);
  return false;
}

/** The forwarded order, watched until the Canal is on the map or in the queue (true), or PLACE_MS runs out. */
async function canalLanded(cityID, loc, ctype, path) {
  const local = GameContext.localPlayerID;
  const t0 = Date.now();
  while (Date.now() - t0 < PLACE_MS) {
    await sleep(100);
    const c = canalOn(loc);
    // a production order goes into the queue and reaches the map at once or later (s1, cm2): either is taken
    if (!c && !path.purchase && inQueue(cityID, ctype)) { log(`Canal queued at ${loc.x},${loc.y}`); hideWorks(loc); return true; }
    if (!c) continue;
    landed(loc, c, path, local);
    return true;
  }
  return false;
}

/** The Canal is on the map: charged if the mod sold it, and a bought one opened. */
function landed(loc, c, path, local) {
  if (path.soldFor != null) {
    safe(() => Players.grantYield(local, YieldTypes.YIELD_GOLD, -path.soldFor));
    log(`Canal sold by the mod at ${loc.x},${loc.y} for ${path.soldFor} gold (its tech was researched before the mod was added)`);
  }
  log(`Canal ${path.purchase ? "bought" : "queued"} at ${loc.x},${loc.y} on ${districtAt(loc) || "no district"}`);
  if (path.purchase && c.complete) setTimeout(() => openCanal(loc, local), SETTLE_MS);
  else hideWorks(loc);
}

function wrapSendRequest(oSend, path) {
  return function (cityID, type, args, ...rest) {
    if (onCanalTile(cityID, type, args, path)) return false;
    const loc = canalOrderAt(type, args, path);
    if (!loc) return oSend(cityID, type, args, ...rest);
    return orderCanal(cityID, loc, args, path, () => oSend(cityID, type, args, ...rest));
  };
}

/** Another building's order aimed at an opened canal, or at the tile of a Canal in the city's queue: refused. */
function onCanalTile(cityID, type, args, path) {
  const other = args && args.ConstructibleType != null && !canalIndex(args.ConstructibleType);
  if (!(state.enabled && type === path.type && other)) return false;
  const at = plotOf(args);
  if (!at) return false;
  if (loadOpen().some((e) => e.plot === idx(at))) { log(`refused a building on the canal at ${at.x},${at.y}`); return true; }
  if (!queuedCanalTiles(cityID).has(idx(at))) return false;
  log(`refused a building on the tile of the Canal queued at ${at.x},${at.y}`);
  return true;
}

/** The tile of a Canal order the mod places, or null for an order the engine gets as it is. */
function canalOrderAt(type, args, path) {
  if (!state.enabled || state.multiplayer || type !== path.type || !args
    || !canalIndex(args.ConstructibleType)) return null;
  const loc = plotOf(args);
  // never prepare a resource tile or park land: the building will be refused, and the district would already have
  // replaced whatever improvement stood there
  if (!loc || !isIsthmus(loc) || hasResource(loc) || isParkland(loc)) return null;
  return loc;
}

/** A Canal order on a site: sold by the mod, refused for gold, or placed (placeCanal). */
function orderCanal(cityID, loc, args, path, forward) {
  const def = canalDef(args.ConstructibleType);
  const general = safe(() => path.oCan.call(path.host, cityID, path.type,
    { ConstructibleType: args.ConstructibleType }, false), null);
  if (path.purchase && engineSaysNo(general) && unlockedByMod(cityOwner(cityID), def, general))
    return sellCanal(cityID, loc, def, args, path);
  // checked before the tile is touched: a purchase the engine refuses for gold would leave its urban district behind
  if (path.purchase && cannotAfford(cityID, def)) {
    log(`not enough gold for the Canal at ${loc.x},${loc.y} (${modPrice(cityID, def).cost})`);
    return false;
  }
  placeCanal(cityID, loc, args.ConstructibleType, forward, path);
  return true;
}

/** A Canal the engine keeps locked though its tech is known: placed by the mod and charged (see unlockedByMod). */
function sellCanal(cityID, loc, def, args, path) {
  const price = modPrice(cityID, def);
  if (price.short) { log(`not enough gold for the Canal at ${loc.x},${loc.y} (${price.cost})`); return false; }
  const place = () => safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
    { Kind: "CONSTRUCTIBLE", Type: def.ConstructibleType, Location: { x: loc.x, y: loc.y }, Owner: cityOwner(cityID) }));
  placeCanal(cityID, loc, args.ConstructibleType, place, { ...path, soldFor: price.cost });
  return true;
}

/** Wrap one host's canStart/sendRequest for the operation that places a building through it. */
function wrapHost(host, type, purchase) {
  if (!host || typeof host.canStart !== "function" || typeof host.sendRequest !== "function") return null;
  const saved = { host, type, canStart: host.canStart, sendRequest: host.sendRequest };
  const path = { host, type, purchase, oCan: saved.canStart };
  host.canStart = wrapCanStart(saved.canStart.bind(host), type, purchase);
  host.sendRequest = wrapSendRequest(saved.sendRequest.bind(host), path);
  if (typeof host.canStartQuery === "function") {
    saved.canStartQuery = host.canStartQuery;
    host.canStartQuery = wrapCanStartQuery(saved.canStartQuery.bind(host), host, type);
  }
  return saved;
}

export {
  canalDef, eligiblePlots, isObsolete, isOfferedCanal, placeCanal, plainBuilding, unlockNode, unlockedByMod,
  wrapHost
};
