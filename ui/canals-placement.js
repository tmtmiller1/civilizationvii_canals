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
  AGE_RANK, BUILD_RADIUS, CANAL_TYPES, J, ONE_TILE_CANAL, PLACE_MS, SETTLE_MS, canalIndex, forget, loadOpen,
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
  for (const def of safe(() => [...GameInfo.Constructibles].filter(plainBuilding), [])) {
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
  return safe(() => city.getPurchasedPlots() || [], [])
    .filter((p) => unfinishedCanal(cityID, locOf(p)) || freshSite(p, s));
}

/** One of the settlement's tiles judged as a new site (see eligiblePlots). */
function freshSite(p, s) {
  const loc = locOf(p);
  if (!inBuildReach(p, loc, s)) return false;
  if (!isIsthmus(loc) || hasResource(loc) || isParkland(loc)) return false;
  // a building of the age, or an ageless one, keeps its tile; obsolete ones the canal replaces
  if (occupants(loc).some((o) => !isImprovement(o.type) && !isObsolete(o.type))) return false;
  if (canalOn(loc) || loadPending().includes(p)) return false;
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
      if (!eligiblePlots(cityID, true, purchase).includes(idx(loc)))
        return { ...res, Success: false, FailureReasons: ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
    }
    const general = loc ? oCan(cityID, type, { ConstructibleType: args.ConstructibleType }, ...rest) : res;
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
    if (loc) {
      if (short) return { ...res, ...open, Success: false, FailureReasons: ["LOC_CITY_PURCHASE_INSUFFICIENT_FUNDS"] };
      return { ...res, ...open, Success: true, FailureReasons: [] };
    }
    const plots = eligiblePlots(cityID, false, purchase);
    const ok = plots.length > 0 && !short;
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
 * A Canal order on its tile: the site marker goes on first, the engine's own verdict is waited for, any obsolete
 * building on the tile is taken off (the canal takes the whole tile), and the order is forwarded. The engine places
 * the Canal on whatever district the tile has, or makes one itself (cm2, 2026-10-08): nothing is built by script.
 * A purchased Canal lands complete with no completion event (c36), so the commit opens it.
 */
async function placeCanal(cityID, loc, ctype, forward, path) {
  const soldFor = path.soldFor;
  const local = GameContext.localPlayerID;
  const plot = idx(loc);
  const engineAccepts = () => safe(() => {
    const r = path.oCan.call(path.host, cityID, path.type, { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false);
    return !!(r && r.Success);
  }, false);
  // A bare tile gets a rural district first, held by the city: the engine then takes the Canal on it as on any
  // worked tile, a town's as a city's, and no urban construction site is ever drawn. (A bare tile left to the engine
  // takes an urban district in a city and is refused in a town: cm2, wm3.)
  const madeDistrict = districtAt(loc) === "";
  if (madeDistrict && !await createRuralDistrict(loc, cityID, cityOwner(cityID))) {
    log(`no district for the Canal at ${loc.x},${loc.y}; not placed`); return;
  }
  const undo = async () => { if (madeDistrict) await destroyDistrict(loc); };
  // the engine takes a Canal only on a marked site (data/canals-sites.xml); a Canal the mod sells itself needs none
  if (soldFor == null) {
    if (!await markSite(loc, markerFor((canalDef(ctype) || {}).ConstructibleType))) log(`the site marker did not land at ${loc.x},${loc.y}`);
    for (let k = 0; k < 20 && !engineAccepts(); k++) await sleep(100);
    if (!engineAccepts()) {
      log(`the engine refuses the Canal at ${loc.x},${loc.y}: ${J(safe(() => path.oCan.call(path.host, cityID, path.type, { ConstructibleType: ctype, X: loc.x, Y: loc.y }, false), null))}`);
      if (plot in loadSites() && !aiSites().has(plot)) await unmarkSite(loc);
      await undo();
      return;
    }
  }
  for (const o of occupants(loc)) if (!isImprovement(o.type) && isObsolete(o.type))
    safe(() => Game.PlayerOperations.sendRequest(local, "DESTROY_ELEMENT", { Kind: "CONSTRUCTIBLE", Owner: o.owner, LocalID: o.id }));
  remember(plot);
  showWorks(loc);
  forward();
  const t0 = Date.now();
  while (Date.now() - t0 < PLACE_MS) {
    await sleep(100);
    const c = canalOn(loc);
    // a production order goes into the queue and reaches the map at once or later (s1, cm2): either is taken
    if (!c && !path.purchase && inQueue(cityID, ctype)) { log(`Canal queued at ${loc.x},${loc.y}`); hideWorks(loc); return; }
    if (!c) continue;
    if (soldFor != null) {
      safe(() => Players.grantYield(local, YieldTypes.YIELD_GOLD, -soldFor));
      log(`Canal sold by the mod at ${loc.x},${loc.y} for ${soldFor} gold (its tech was researched before the mod was added)`);
    }
    log(`Canal ${path.purchase ? "bought" : "queued"} at ${loc.x},${loc.y} on ${districtAt(loc) || "no district"}`);
    if (path.purchase && c.complete) setTimeout(() => openCanal(loc, local), SETTLE_MS);
    else hideWorks(loc);
    return;
  }
  hideWorks(loc);
  log(`the engine did not take the Canal at ${loc.x},${loc.y}`);
  forget(plot);
  if (plot in loadSites() && !aiSites().has(plot)) await unmarkSite(loc);
  await undo();
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
      placeCanal(cityID, loc, args.ConstructibleType, place, { ...path, soldFor: price.cost });
      return true;
    }
    // checked before the tile is touched: a purchase the engine refuses for gold would leave its urban district behind
    if (path.purchase && cannotAfford(cityID, def)) {
      log(`not enough gold for the Canal at ${loc.x},${loc.y} (${modPrice(cityID, def).cost})`);
      return false;
    }
    placeCanal(cityID, loc, args.ConstructibleType, () => oSend(cityID, type, args, ...rest), path);
    return true;
  };
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

export { canalDef, eligiblePlots, isObsolete, isOfferedCanal, plainBuilding, unlockNode, unlockedByMod, wrapHost };
