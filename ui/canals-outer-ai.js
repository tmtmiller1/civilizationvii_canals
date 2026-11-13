// canals-outer-ai.js - Canals, game scope.
//
// AI civilizations get canals past ring 3 the way the player does: bought, never built, since the game's build queue
// and purchase both stop at ring 3 (canals-reach.js). The AI builds its own canals inside ring 3 on the sites Canals
// marks for it (canals-sites.js); out here Canals buys the Canal for it, from its own treasury, at the game's price.
//
// It buys only when a canal there makes sense, and sparingly:
// - the tile is a site Canals rates worth digging for the AI (canalWorth: a cut that saves at least six tiles of
//   sailing or joins a large body of water), the same test that picks the AI's sites inside ring 3;
// - the AI has the Canal's tech, isn't at war, and keeps twice the price in gold after paying;
// - one purchase per AI civilization per turn, and one canal past ring 3 per settlement;
// - only where inReach allows a purchase.
// It runs at the start of the local player's turn, the time a script's changes to an AI's tiles are accepted
// (engine-closed.md, 2026-11-12), and never in a network game.
"use strict";

import { districtAt, isWater, locOf, occupants } from "./canals-map.js";
import { createRuralDistrict, openCanal } from "./canals-open.js";
import { eligiblePlots, unlockNode } from "./canals-placement.js";
import { inReach, pastNativeRing } from "./canals-reach.js";
import { canalWorth } from "./canals-rule.js";
import { aiMajors, thisAgesCanal } from "./canals-sites.js";
import { CANAL_TYPES, loadOpen, loadPending, log, safe, sleep, state } from "./canals-state.js";

/** Gold the AI keeps after paying, as a multiple of the price. */
const RESERVE = 2;

/** Whether player `pid` is at war with anyone. */
function atWar(pid) {
  for (let o = 0; o < 64; o++) {
    if (o === pid) continue;
    if (safe(() => Players.get(pid).Diplomacy.isAtWarWith(o), false) === true) return true;
  }
  return false;
}

/** Whether the AI has the Canal's tech. */
function hasTech(pid, def) {
  const node = unlockNode(def);
  return !node || !!safe(() => Players.get(pid).Techs.isNodeUnlocked(node), false);
}

/** How many canals past ring 3 this settlement already has, opened or under way. */
function outerCanalsOf(city) {
  const centre = safe(() => city.location, null);
  const cid = safe(() => city.id.id, -1);
  const mine = (plot) => {
    const l = locOf(plot);
    const oc = safe(() => GameplayMap.getOwningCityFromXY(l.x, l.y), null);
    return pastNativeRing(centre, l) && oc && oc.id === cid;
  };
  return loadOpen().filter((e) => mine(e.plot)).length + loadPending().filter(mine).length;
}

/** The settlement's best outer site worth a canal, or null. */
function bestOuterSite(city) {
  const centre = safe(() => city.location, null);
  let best = null;
  for (const p of eligiblePlots(city.id, true)) {
    const loc = locOf(p);
    if (!pastNativeRing(centre, loc) || !inReach(centre, loc, true) || isWater(loc)) continue;
    if (occupants(loc).some((o) => CANAL_TYPES.includes(o.type))) continue;
    const w = canalWorth(loc);
    if (w.worth > 0 && (!best || w.worth > best.worth)) best = { loc, worth: w.worth, why: w.why };
  }
  return best;
}

/** One AI civilization's purchase this turn, if one makes sense: the settlement and site, with the price. */
function pickPurchase(pid, def) {
  if (!hasTech(pid, def) || atWar(pid)) return null;
  const gold = safe(() => Players.get(pid).Treasury.goldBalance, 0);
  let pick = null;
  for (const city of safe(() => Players.get(pid).Cities.getCities() || [], [])) {
    if (outerCanalsOf(city) >= 1) continue;
    const cost = () => city.Gold.getBuildingPurchaseCost(YieldTypes.YIELD_GOLD, def.ConstructibleType);
    const price = Math.round(safe(cost, 0));
    if (!(price > 0) || gold < price * (RESERVE + 1)) continue;
    const site = bestOuterSite(city);
    if (site && (!pick || site.worth > pick.site.worth)) pick = { city, site, price };
  }
  return pick;
}

/** The Canal placed for the AI and opened: district, Canal with Parent, the gold, then Canals' own opening. */
async function buyFor(pid, def, pick) {
  const { city, site, price } = pick;
  const loc = site.loc;
  if (districtAt(loc) === "" && !await createRuralDistrict(loc, city.id, pid)) return false;
  safe(() => Game.PlayerOperations.sendRequest(GameContext.localPlayerID, "CREATE_ELEMENT",
    { Kind: "CONSTRUCTIBLE", Type: def.ConstructibleType, Location: { x: loc.x, y: loc.y }, Parent: city.id, Owner: pid }));
  for (let i = 0; i < 30 && !occupants(loc).some((o) => o.type === def.ConstructibleType); i++) await sleep(100);
  if (!occupants(loc).some((o) => o.type === def.ConstructibleType)) {
    log(`AI ${pid}: the Canal at ${loc.x},${loc.y} past ring 3 did not land; nothing charged`);
    return false;
  }
  safe(() => Players.grantYield(pid, YieldTypes.YIELD_GOLD, -price));
  log(`AI ${pid} bought a Canal past ring 3 at ${loc.x},${loc.y} for ${price} gold (${site.why})`);
  await openCanal(loc, pid);
  return true;
}

/** At the start of the local player's turn: at most one outer canal per AI civilization, where one makes sense. */
async function aiOuterCanals() {
  if (!state.enabled || state.multiplayer) return 0;
  const def = thisAgesCanal();
  if (!def) return 0;
  let bought = 0;
  for (const pid of aiMajors()) {
    const pick = safe(() => pickPurchase(pid, def), null);
    if (pick && await buyFor(pid, def, pick)) bought++;
  }
  return bought;
}

export { RESERVE, aiOuterCanals, bestOuterSite, buyFor, outerCanalsOf, pickPurchase };
