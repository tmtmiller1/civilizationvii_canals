// canals-save.js - Canals, game scope.
//
// Canals as land in every save: the save wrap, the age's end, the held autosave, the land look after a load. Split out
// of canals.js (docs/split-plan.md).
"use strict";

import { locOf, terrainOf } from "./canals-map.js";
import { sweep } from "./canals-repair.js";
import { syncSites } from "./canals-sites.js";
import { OPEN_KEY, loadOpen, log, safe, state, withBlock } from "./canals-state.js";

function rememberOpen(plot, age, cliffs, land) {
  const l = loadOpen();
  if (!l.some((e) => e.plot === plot)) {
    l.push({ plot, age, cliffs: cliffs || [], land: land || "TERRAIN_FLAT" });
    safe(() => Configuration.editGame().setValue(OPEN_KEY, JSON.stringify(l)));
  }
}
/** An opened canal dug again in a later age: its record takes that age (redigCanal); the rest of it stays. */
function renewOpen(plot, age) {
  const l = loadOpen(); const e = l.find((x) => x.plot === plot);
  if (!e || e.age === age) return false;
  e.age = age;
  safe(() => Configuration.editGame().setValue(OPEN_KEY, JSON.stringify(l)));
  return true;
}

// keeping the land look across loads
//
// A load draws each hex from the terrain in the save, and a Coast hex comes out as open sea: the canal was gone
// from sight after every reload. So a canal is land in every save and Coast while the player plays; after a load it
// is turned to Coast again at once and drawn over the land mesh.
//
// The retype must land before a save starts, never during one: a canal retyped inside StartSaveRequest crashed the
// game on the save's worker thread (c71, c75: same stack), while the same canal already land when the autosave began
// saved cleanly (c74). Every save the UI makes goes through Network.saveGame, which is wrapped: the canals go to land,
// the save is sent once the map reads them as land, and they are Coast again on SaveComplete.
//
// The engine's own autosave is written between TurnEnd and TurnBegin, with StartSaveRequest about 90 ms after TurnEnd
// (te1, 2026-10-18). A retype to land reads back in 25 ms, so the canals go to land in the TurnEnd handler and the
// autosave, on the player's own frequency, holds them as land (te1: five turns, the save loaded with none as Coast,
// no crash); they are Coast again at TurnBegin. Up to 1.5.5 the mod held the engine's autosave instead and wrote its
// own at the start of the player's turn, and that script save stopped the game for over a second on every turn (lag1).
// The canals are Coast through every AI turn, so AI ships use them. Nothing retypes a plot while state.hold is set,
// so a Canal finished in that window opens at the next sweep.

/** How long a save waits for a canal that is opening (the whole opening takes under ten seconds). */
const OPENING_WAIT_MS = 15000;

/** Retype the opened canals: "land" turns each Coast one back to the terrain it was cut from, "coast" the reverse. */
function retypeCanals(to) {
  const changed = [];
  try {
    withBlock(() => {
      for (const e of loadOpen()) {
        const loc = locOf(e.plot); const now = terrainOf(loc);
        if ((to === "land") !== (now === "TERRAIN_COAST")) continue;
        const want = to === "land" ? (e.land || "TERRAIN_FLAT") : "TERRAIN_COAST";
        const t = safe(() => GameInfo.Terrains.lookup(want).$index, -1);
        if (t < 0) continue;
        WorldBuilder.MapPlots.setTerrain(t, loc); changed.push(e.plot);
      }
    });
  } catch (err) { log("retype to " + to + " threw " + err); }
  return changed;
}

const readsLand = () => loadOpen().every((e) => terrainOf(locOf(e.plot)) !== "TERRAIN_COAST");

/** Turn the canals to land ahead of a save and hold every retype until they are Coast again. */
function landAhead(why) {
  if (!state.enabled || state.multiplayer) return 0;
  state.hold = true;
  const n = state.saving ? 0 : retypeCanals("land").length;
  if (n) log(`${why}: ${n} canal tile(s) to land ahead of the save`);
  return n;
}

/** The hold is over: canals back to Coast (never while a save runs or is about to, nor once the age is over). */
function coastAgain() {
  if (state.saving || state.loading || state.pendingSave) return [];
  if (ageIsOver()) { state.hold = true; retypeCanals("land"); return []; }
  state.hold = false;
  return retypeCanals("coast");
}

// The next age is built from the map as this one leaves it. The transition is a save of its own
// (SaveFileTypes.GAME_TRANSITION), and the new age's map script recomputes the water bodies from the terrain it
// inherits (TerrainBuilder.storeWaterData, base-standard/scripts/age-transition-post-load.js). A canal still Coast
// at that point would come into the new age as open sea. So once the age is over the canals turn to land and stay
// land; the new age loads them as land, like any save, and they turn Coast again after that load. "One more turn"
// (an extended game) is ordinary play: the canals are water again at the next turn start.

/** The age has ended and play does not go on past it. */
function ageIsOver() {
  const m = safe(() => Game.AgeProgressManager, null);
  if (m && safe(() => m.isExtendedGame, false)) return false;
  return state.ageEnded || !!(m && safe(() => m.isAgeOver, false));
}
/** GameAgeEnded, and again on BeforeAgeTransition: land the canals now (a retype never runs during a save). */
function onAgeEnded() {
  if (!state.enabled || state.multiplayer) return;
  state.ageEnded = true;
  if (!loadOpen().length) return;
  const n = landAhead("the age is over");
  if (!n && !readsLand()) log("the age is over during a save; the canals turn to land when it completes");
}

function onSaveStart() {
  if (!state.enabled || state.multiplayer) return;
  state.saving = true; state.hold = true;
  if (!readsLand()) log("save started with a canal still Coast: it reloads as open water");
}
function onSaveDone() {
  if (!state.enabled || state.multiplayer) return;
  state.saving = false; state.pendingSave = false;
  coastAgain();
  if (state.reloadFrom) {
    const name = state.reloadFrom; state.reloadFrom = null;
    setTimeout(() => {
      const ok = safe(() => Network.loadGame(autosaveParams(name), ServerType.SERVER_TYPE_NONE), false);
      log(`reload from ${name}: ${ok ? "sent" : "refused"}`);
    }, 1000);
  }
}

/** Network.saveGame, but the canals are land on the map before the save is sent. */
function wrapSaveGame(host) {
  const original = host.saveGame;
  host.saveGame = function (params) {
    if (!state.enabled || state.multiplayer || state.saving || !loadOpen().length) return original.call(host, params);
    state.pendingSave = true;
    const t0 = Date.now(); let landed = false;
    const send = () => {
      // A canal opening now (its tile water and on record, its district, boat and building still to come) finishes
      // first: a save taken half-way through held the tile bare, and it reloaded as water with no Canal on it (fx4).
      if (state.busy.size && Date.now() - t0 < OPENING_WAIT_MS) { setTimeout(send, 100); return; }
      if (!landed) { landed = true; landAhead("save"); }
      if (!readsLand() && Date.now() - t0 < OPENING_WAIT_MS + 3000) { setTimeout(send, 50); return; }
      // one more beat after the read, so the retype is settled before the save thread starts
      setTimeout(() => {
        const ok = safe(() => original.call(host, params), false);
        if (!ok) { log("save refused by the engine"); state.pendingSave = false; coastAgain(); }
      }, 100);
    };
    send();
    return true; // the save screen then waits for SaveComplete, as it does for any save
  };
  return original;
}

// The engine's autosave frequency is a user setting (UserOptions.txt). While a canal is open it is stored as
// Up to 1.5.5 the mod held the engine's autosave by storing the player's frequency as 1000 + their value. The value is
// in the player's settings, so one saved under that version is put back here, as ui/canals-shell.js does at the menu.
const AUTOSAVE_HELD = 1000;
function releaseEngineAutosave() {
  const u = safe(() => Configuration.getUser(), null); const f = safe(() => u.autoSaveFrequency, 0);
  if (f < AUTOSAVE_HELD) return;
  safe(() => u.setAutoSaveFrequency(Math.max(1, f - AUTOSAVE_HELD)));
  log(`autosave frequency back to the player's ${Math.max(1, f - AUTOSAVE_HELD)} (was held at ${f})`);
}

/** The turn is over and the engine's autosave may follow at once: the canals to land first. */
function onTurnEnd() {
  if (!state.enabled || state.multiplayer || !loadOpen().length) return;
  landAhead("turn end");
}
/** The new turn: Coast again (not while a save still runs; onSaveDone does it then). */
function onTurnBegin() {
  if (!state.enabled || state.multiplayer || !loadOpen().length) return;
  coastAgain();
}

/** The engine's own name for an autosave, AutoSave_<age>_<turn> (AutoSave_01_0072: Exploration, turn 72), used by the
 * reload the mod offers on a save from Canals 1.0.0. */
function autosaveName(turn) {
  const age = safe(() => GameInfo.Ages.lookup(Game.age).ChronologyIndex, 0);
  return `AutoSave_${String(age).padStart(2, "0")}_${String(turn).padStart(4, "0")}`;
}
function autosaveParams(name) {
  return { Location: SaveLocations.LOCAL_STORAGE, LocationCategories: SaveLocationCategories.AUTOSAVE,
    Type: SaveTypes.SINGLE_PLAYER, ContentType: SaveFileTypes.GAME_STATE, FileName: name };
}

// The local player as the game was loaded: GameContext.localPlayerID does not read it while Autoplay runs (c76).
function isLocal(d) { return !!d && (d.player ?? d.Player) === state.localId; }

// Loading an autosave makes the engine save again as the game starts (c78; c79: StartSaveRequest 55 ms after
// GameStarted, at the Begin Game press). So the canals stay as loaded until the game has started and no save has run
// for a few seconds, then turn Coast; a retype during that load-time save would be the crash above.
const LOAD_QUIET_MS = 3000;

/** After a load: canals that came in as land are drawn as land this session, and turn Coast once the game is up. */
function keepLandLook() {
  state.loading = true; state.hold = true;
  // A save that holds a canal as Coast was written by Canals 1.0.0, which kept canals as water in saves. The load
  // has already drawn it as open sea, and no retype redraws a hex in play (c99), but turned to land at once it is
  // land in every save from here on, the one the game writes as it starts included; see offerReload.
  const stale = retypeCanals("land");
  if (stale.length) log(`load: ${stale.length} canal tile(s) saved as Coast (an older save), turned to land`);
  for (const e of loadOpen()) if (!stale.includes(e.plot) && terrainOf(locOf(e.plot)) !== "TERRAIN_COAST") state.landMesh.add(e.plot);
  state.staleLoad = stale;
  const t0 = Date.now(); let quietSince = 0;
  const up = () => UI.getGameLoadingState() === UIGameLoadingState.GameStarted;
  const started = () => safe(up, Date.now() - t0 > 15000);
  const poll = () => {
    if (!started() || state.saving) { quietSince = 0; setTimeout(poll, 250); return; }
    if (!quietSince) quietSince = Date.now();
    if (Date.now() - quietSince < LOAD_QUIET_MS) { setTimeout(poll, 250); return; }
    state.loading = false;
    const n = coastAgain().length;
    if (n) log(`load: ${n} canal tile(s) back to Coast, drawn over the land`);
    setTimeout(sweep, 1000); // the overlay is drawn on tiles that read Coast, a beat after the retype
    setTimeout(syncSites, 2000); // a game begun with the mod, or with a new site since the save: mark it now
  };
  poll();
}

export {
  autosaveName, autosaveParams, coastAgain, isLocal, keepLandLook, onAgeEnded, onSaveDone, onSaveStart, onTurnBegin,
  onTurnEnd, releaseEngineAutosave, rememberOpen, renewOpen, wrapSaveGame
};
