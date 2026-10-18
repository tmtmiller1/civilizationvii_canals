// canals-sites.js - Canals, game scope.
//
// The site markers the engine and the AI go by. Split out of canals.js (docs/split-plan.md).
"use strict";

import { canalOn, clearableFeature, featureOf, idx, isWater, locOf } from "./canals-map.js";
import { canalDef, eligiblePlots, isOfferedCanal } from "./canals-placement.js";
import { canalWorth } from "./canals-rule.js";
import {
  CANAL_TYPES, ONE_TILE_CANAL, loadOpen, loadPending, log, oneTileMode, safe, sleep, state
} from "./canals-state.js";

// canal sites
//
// The Canal requires a site marker on its tile (data/canals-sites.xml, Constructible_RequiredFeatures), so the engine
// offers it, to the game's own AI as to the player, only on a tile this script has marked. The canal rule itself (land
// beside water a ship can sail, each age's longest run) is the script's: the engine's data cannot express it, and
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

function markerFor(type) { return type === ONE_TILE_CANAL ? ONE_TILE_SITE_FEATURE : SITE_FEATURE; }
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
  const want = featureName(f);
  const at = { x: loc.x, y: loc.y };
  // never while a save is written: the save thread reads the map. Wait it out; a save that runs on is left alone.
  // (Only the write itself: a save that is waiting for an opening to finish must not hold up the opening's marker.)
  for (let k = 0; k < 50 && state.saving; k++) await sleep(100);
  if (state.saving) return false;
  if (featureOf(loc) && featureOf(loc) !== want) await clearOtherFeature(loc, at);
  if (want && featureOf(loc) !== want) {
    safe(() => WorldBuilder.MapPlots.setFeature(f, at));
    for (let k = 0; k < 30 && featureOf(loc) !== want; k++) await sleep(100);
  }
  return featureOf(loc) === want;
}

/** A feature index by name, "" for none. */
function featureName(f) {
  return f === FeatureTypes.NO_FEATURE ? "" : safe(() => String(GameInfo.Features.lookup(f).FeatureType), "?");
}
/** The feature the tile has taken off first, when it isn't the one wanted (putFeature). */
async function clearOtherFeature(loc, at) {
  safe(() => WorldBuilder.MapPlots.setFeature(FeatureTypes.NO_FEATURE, at));
  for (let k = 0; k < 30 && featureOf(loc); k++) await sleep(100);
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
  const types = canalKeys();
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

/** Every Canal's constructible index and type hash, the two ways a queue item names its building. */
function canalKeys() {
  const types = new Set();
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (!d) continue;
    types.add(d.$index);
    const h = safe(() => GameInfo.Types.lookup(t).Hash, null);
    if (h != null) types.add(h);
  }
  return types;
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
  for (const [pid, city] of aiSettlements()) for (const p of eligiblePlots(city.id, true)) addSite(out, pid, p);
  return out;
}

/** Each AI major's settlements, as [player, city]. */
function aiSettlements() {
  const out = [];
  for (const pid of aiMajors()) {
    for (const city of safe(() => Players.get(pid).Cities.getCities() || [], [])) out.push([pid, city]);
  }
  return out;
}
function addSite(out, pid, p) {
  const w = canalWorth(locOf(p));
  if (w.worth > 0) out.set(p, { pid, why: w.why, feature: offeredMarker() });
}

// The same pass in slices of about FRAME_SLICE_MS, a frame drawn between them. Run whole it held the game for
// 110-130 ms at each turn start on a Huge map at turn 77 (52 AI settlements); one tile's worth, with its search over
// the water, can take 10 ms or more, so a slice may end between two tiles of a settlement.
const FRAME_SLICE_MS = 4;
function clock() { return safe(() => globalThis.performance.now(), Date.now()); }
/** The next frame, or 50 ms, whichever comes first: a hidden window may draw no frames. */
function nextFrame() {
  if (typeof requestAnimationFrame !== "function") return sleep(0);
  return new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(go); setTimeout(go, 50); });
}
async function aiSitesSpread() {
  const out = new Map();
  let t0 = clock();
  const pause = async () => { if (clock() - t0 > FRAME_SLICE_MS) { await nextFrame(); t0 = clock(); } };
  for (const [pid, city] of aiSettlements()) {
    await pause();
    const plots = eligiblePlots(city.id, true);
    for (const p of plots) { await pause(); addSite(out, pid, p); }
  }
  return out;
}

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

/** Every tile that should hold a marker, with the marker: the AI's sites, queued Canals, the player's orders. */
async function wantedSites() {
  const want = await aiSitesSpread();
  // An order already given keeps the marker of the Canal it is for, whatever the mode is now.
  const queued = queuedCanalOrders();
  for (const [p, o] of queued) want.set(p, { pid: o.pid, why: "queued", feature: markerFor(o.type) });
  for (const p of loadPending()) if (!want.has(p)) want.set(p, { pid: state.localId, why: "ordered", feature: offeredMarker() });
  return want;
}

/** Off, a network game, a pass already running, or no marker in the database. */
function syncWaits() { return !state.enabled || state.multiplayer || state.syncing || siteIndex() == null; }

/** Marks every AI site, every tile of a Canal order or queued Canal, and the opened canals; unmarks the rest. */
async function syncSites() {
  if (syncWaits()) return;
  state.syncing = true;
  try {
    const want = await wantedSites();
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

export {
  SITE_FEATURES, aiMajors, aiSites, aiSitesSpread, loadSites, markCanalTile, markSite, markerFor, queuedCanalOrders,
  queuedCanalPlots, syncSites, thisAgesCanal, unmarkSite
};
