// canals.js - Canals, a Civilization VII mod. Game scope.
//
// What it does (the runs behind each step are in docs/verification-runs.md):
//   1. Placement. The Canal buildings (data/canals.xml) carry no terrain rule of their own; this script decides
//      where they may go by wrapping the two calls that place a building: Game.CityOperations BUILD (production)
//      and Game.CityCommands PURCHASE (gold, the only way a town gets a building). For a Canal, the offered plots
//      are the plots the engine offers a plain building of the age through the same path, narrowed to tiles beside
//      ship water or beside a canal (isIsthmus), and the per-plot check refuses anything else. The same verdict is
//      written into canStartQuery, which is what the production and purchase lists are built from. The engine itself
//      takes a Canal only on a tile holding the site marker (data/canals-sites.xml), which the order places: see
//      "canal sites".
//   2. Commit. A bare tile gets a rural district first (held by the city). The chosen tile is marked, the engine's
//      own per-plot yes is waited for, any obsolete building on the tile is taken off, and the order is
//      forwarded; the engine places the Canal on the district the tile has (cm2), so no urban district is ever
//      made. The tile is remembered in the save (GameConfiguration key) so a
//      reload mid-construction still finishes the job. A purchased Canal lands complete with no completion event
//      (c36), so the commit opens it.
//   3. Completion. On ConstructibleBuildCompleted for a Canal on a site: the tile is retyped to Coast
//      (WorldBuilder.MapPlots.setTerrain, the feature cleared first) and the canal look (channel, quay, boats) is
//      drawn on it from shipped meshes. On a rural tile the Canal stays and a fishing boat replaces the improvement.
//      On an urban tile the Canal and the district are destroyed and the plot bought back, then the tile is settled
//      as a worked rural fishing tile holding the Canal. Ships path through at once. A Canal completed on a tile
//      that is not a site (an AI's, or a stale save) is left alone.
//   4. Safety net. On load and at the start of every turn, every remembered tile and every complete Canal on the
//      map is re-checked, so a missed event is caught on the next turn.
//   Multiplayer: the terrain retype is a local call, not a networked operation, so in a network game the Canal is
//   not offered and completed Canals are left as buildings.
//   One-tile mode (Options > Add-ons, ui/canals-settings.js): an alternative to the age rules, not a replacement.
//   The age Canals are not offered; one Canal with no age is (BUILDING_CANAL_ONE_TILE), unlocked by Irrigation in
//   Antiquity and by nothing later, always a single tile, with no ship limit, the same cost and yields in every age,
//   and drawn in the style of the age being played. A canal keeps the rules of the Canal that
//   dug it, so switching the mode mid-game changes only what is offered from then on.
"use strict";

import {
  WORKS_VFX, clearOverlay, drawOverlay, redrawNeighbours, runArms, runOf, setWorksVfx, waterSideIndexes, works
} from "./canals-look.js";
import { hasResource, idx, locOf, waterAreas } from "./canals-map.js";
import { districtHolder, localTurnActive, openCanal } from "./canals-open.js";
import { eligiblePlots, unlockNode, unlockedByMod, wrapHost } from "./canals-placement.js";
import { repairCitylessDistricts, sweep } from "./canals-repair.js";
import { canalWorth, isIsthmus, waterSides } from "./canals-rule.js";
import {
  autosaveName, autosaveParams, holdEngineAutosave, isLocal, keepLandLook, onAgeEnded, onSaveDone, onSaveStart,
  onTurnDeactivated, wrapOptionsScreen, wrapSaveGame, writeAutosave
} from "./canals-save.js";
import {
  aiMajors, aiSites, loadSites, markCanalTile, markSite, queuedCanalOrders, queuedCanalPlots, syncSites,
  thisAgesCanal, unmarkSite
} from "./canals-sites.js";
import {
  CANAL_TYPES, G, J, KEY, ONE_TILE, SETTLE_MS, loadOpen, loadPending, log, oneTileMode, safe, state
} from "./canals-state.js";
import { gameHasMode, getMode, pinModeToGame } from "/tower-canals/ui/canals-settings.js";

/** Ships that may pass a canal per turn, by its age; the local player's orders are the only ones a script can hold.
 * Off: no ship limit. Set TRANSIT_LIMIT to true to install the quota (wrapUnitSend) again. */
const TRANSIT_LIMIT = false;
const TRANSITS_PER_TURN = { AGE_ANTIQUITY: 1, AGE_EXPLORATION: 2, AGE_MODERN: Infinity, [ONE_TILE]: Infinity };

/** The transit quota, for the local player's own move orders: a path through a canal already used this turn by
 * its quota of ships is not sent. (AI paths are decided natively and cannot be held.) */
function wrapUnitSend(oSend) {
  return function (unitId, type, args, ...rest) {
    try {
      if (limitedMove(type, args) && !transitAllowed(unitId, args)) return false;
    } catch (_) { /* never block a move on a script error */ }
    return oSend(unitId, type, args, ...rest);
  };
}
/** A move order of the local player's to a plot, while the mod is on in a single-player game. */
function limitedMove(type, args) {
  return state.enabled && !state.multiplayer && !!args && args.X != null && args.Y != null
    && (type === UnitOperationTypes.MOVE_TO || type === "UNITOPERATION_MOVE_TO");
}
/** A new turn starts every canal's count of ships again. */
function newTransitTurn() {
  const turn = safe(() => Game.turn, -1);
  if (turn !== state.transitTurn) { state.transitTurn = turn; state.transits = new Map(); }
}
/** The ship's path takes no canal past its quota this turn; each canal it passes counts the ship. */
function transitAllowed(unitId, args) {
  newTransitTurn();
  const open = loadOpen();
  if (!open.length) return true;
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
  return true;
}
function onTurnActivated(d) {
  if (!isLocal(d)) return;
  holdEngineAutosave();
  writeAutosave();
  setTimeout(sweep, SETTLE_MS);
  setTimeout(syncSites, 3000); // after the autosave and the sweep
}

function onBuildCompleted(data) {
  if (!state.enabled || state.multiplayer || !data || !data.location) return;
  const def = safe(() => GameInfo.Constructibles.lookup(data.constructibleType), null);
  if (!def || !CANAL_TYPES.includes(String(def.ConstructibleType))) return;
  const loc = { x: data.location.x, y: data.location.y };
  const owner = data.constructible ? data.constructible.owner : undefined;
  setTimeout(() => openCanal(loc, owner), SETTLE_MS);
}

// telling the player

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
 * session (c99: the hex kept its sea mesh after the retype to land). One save and load draws them as canals
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

// install

function install() {
  if (!learnCanalTypes()) return false;
  state.multiplayer = !!safe(() => Configuration.getGame().isNetworkMultiplayer, false);
  // A game keeps the rules it started with: the main menu's choice is written into the save the first time it loads.
  if (!state.multiplayer && !safe(gameHasMode, true)) safe(() => pinModeToGame(getMode()));
  if (!wrapPlacement()) return false;
  hookSaves();
  startPlay();
  const uhost = safe(() => Game.UnitOperations, null);
  if (TRANSIT_LIMIT && uhost && typeof uhost.sendRequest === "function") { state.originals.unitSend = uhost.sendRequest; uhost.sendRequest = wrapUnitSend(uhost.sendRequest.bind(uhost)); }
  log(`active${state.multiplayer ? " (network game: canals not offered)" : ""}: Canal placement limited to isthmus tiles; ` +
    `rules: ${oneTileMode() ? "one-tile canals" : "by age"}`);
  return true;
}

/** The Canal buildings' indexes and type hashes, which the wraps know a Canal order by. False when there are none. */
function learnCanalTypes() {
  for (const t of CANAL_TYPES) {
    const d = safe(() => GameInfo.Constructibles.lookup(t), null);
    if (d) { state.canalIndexes.add(d.$index); safe(() => state.canalIndexes.add(GameInfo.Types.lookup(t).Hash)); }
  }
  if (!state.canalIndexes.size) { log("no Canal buildings in the database; inactive"); return false; }
  return true;
}

/** The production and purchase hosts wrapped. False when production can't be. */
function wrapPlacement() {
  const build = wrapHost(safe(() => Game.CityOperations, null), safe(() => CityOperationTypes.BUILD, null), false);
  if (!build) { log("Game.CityOperations not wrappable; inactive"); return false; }
  state.originals = { hosts: [build] };
  // Towns get buildings only by purchase, which goes through Game.CityCommands, not the production queue.
  const purchase = wrapHost(safe(() => Game.CityCommands, null), safe(() => CityCommandTypes.PURCHASE, null), true);
  if (purchase) state.originals.hosts.push(purchase);
  else log("Game.CityCommands not wrappable; Canals cannot be bought with gold");
  return true;
}

/** The completion and save events heard, the local player kept, and the save call wrapped. */
function hookSaves() {
  safe(() => engine.on("ConstructibleBuildCompleted", onBuildCompleted));
  safe(() => engine.on("StartSaveRequest", onSaveStart));
  safe(() => engine.on("SaveComplete", onSaveDone));
  state.localId = safe(() => GameContext.localPlayerID, -1);
  safe(() => engine.on("PlayerTurnDeactivated", onTurnDeactivated));
  const net = safe(() => Network, null);
  if (net && typeof net.saveGame === "function") state.originals.saveGame = wrapSaveGame(net);
  else log("Network.saveGame not wrappable; a save made from the menu reloads canals as open water");
}

/** The land look and the held autosave, the turn and age events, and the notices once the game is up. */
function startPlay() {
  if (!state.multiplayer) { keepLandLook(); holdEngineAutosave(); wrapOptionsScreen(); }
  safe(() => engine.on("PlayerTurnActivated", onTurnActivated));
  safe(() => engine.on("GameAgeEnded", onAgeEnded));
  safe(() => engine.on("BeforeAgeTransition", onAgeEnded));
  whenStarted(notices, 5000);
}

function uninstall() {
  unwrapHosts();
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

/** The production, purchase and unit hosts given their own calls back. */
function unwrapHosts() {
  for (const h of (state.originals && state.originals.hosts) || []) {
    h.host.canStart = h.canStart; h.host.sendRequest = h.sendRequest;
    if (h.canStartQuery) h.host.canStartQuery = h.canStartQuery;
  }
  const uhost = safe(() => Game.UnitOperations, null);
  if (uhost && state.originals && state.originals.unitSend) uhost.sendRequest = state.originals.unitSend;
}

if (!G[KEY]) {
  G[KEY] = {
    version: "1.5.4",
    set enabled(v) { state.enabled = !!v; },
    get enabled() { return state.enabled; },
    uninstall, isIsthmus, eligiblePlots, openCanal, sweep, loadPending, loadOpen, localTurnActive,
    districtHolder, repairCitylessDistricts,
    drawOverlay, clearOverlay, redrawNeighbours, hasResource,
    aiMajors, thisAgesCanal, waterAreas, reloadThroughSave, canalWorth, waterSides, syncSites, aiSites, markSite,
    unmarkSite, loadSites, queuedCanalPlots, queuedCanalOrders, markCanalTile,
    get mode() { return oneTileMode() ? "one-tile" : "ages"; },
    get worksCount() { return works.size; },
    set worksVfx(v) { setWorksVfx(v); },
    get worksVfx() { return WORKS_VFX; },
    get staleLoad() { return state.staleLoad.slice(); },
    channelArms: (loc) => ({ water: waterSideIndexes(loc), arms: runArms(runOf(loc)).get(idx(loc)) || [] }),
  };
  install();
}

// for the sequence traces (tests/trace): the game imports nothing from this file
export { install, uninstall, wrapUnitSend };
