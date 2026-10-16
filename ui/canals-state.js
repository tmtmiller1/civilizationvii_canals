// canals-state.js - Canals, game scope.
//
// The shared state: constants, the log, the save's pending and open records, the session state object. Split out of
// canals.js (docs/split-plan.md).
"use strict";

import { getMode } from "/tower-canals/ui/canals-settings.js";

const TAG = "[Canals]";
const G = globalThis;
const KEY = "__canals";
const PERSIST_KEY = "Canals_Pending_v1";
const OPEN_KEY = "Canals_Open_v1";
const ONE_TILE_CANAL = "BUILDING_CANAL_ONE_TILE";
const CANAL_TYPES = ["BUILDING_CANAL_ANTIQUITY", "BUILDING_CANAL_EXPLORATION", "BUILDING_CANAL_MODERN", ONE_TILE_CANAL];
/** What an opened one-tile canal records in place of an age: its rules and its look are the same in every age. */
const ONE_TILE = "ONE_TILE";
const SETTLE_MS = 400;
/** How long a forwarded order is given to reach the map or the queue. */
const PLACE_MS = 3000;
const BUILD_RADIUS = 3;

function log(m) { try { console.error(TAG + " " + m); } catch (_) { /* ignore */ } }

/** Whether the one-tile rules are in play. Read from the store at most twice a second: the Options screen can change it
 * at any time, and the placement rule is asked for every tile of every city. */
let modeRead = { at: 0, oneTile: false };
function oneTileMode() {
  const now = Date.now();
  if (now - modeRead.at > 500) modeRead = { at: now, oneTile: safe(() => getMode() === "one-tile", false) };
  return modeRead.oneTile;
}
function safe(fn, fb) { try { return fn(); } catch (_e) { return fb; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function J(o) { try { return JSON.stringify(o); } catch (_) { return "?"; } }

// persistence

/** Remembered Canal sites (plot indexes), kept in the save so a reload mid-construction still completes. */
function loadPending() {
  return safe(() => {
    const v = Configuration.getGame().getValue(PERSIST_KEY); const a = v ? JSON.parse(String(v)) : [];
    return Array.isArray(a) ? a : [];
  }, []);
}
function savePending(list) { safe(() => Configuration.editGame().setValue(PERSIST_KEY, JSON.stringify(list))); }
function remember(plot) { const l = loadPending(); if (!l.includes(plot)) { l.push(plot); savePending(l); } }
function forget(plot) {
  const l = loadPending(); const n = l.filter((p) => p !== plot);
  if (n.length !== l.length) savePending(n);
}
/** Canals opened so far (plot indexes), kept in the save so their overlay is redrawn after a load. */
function loadOpen() { return safe(() => { const v = Configuration.getGame().getValue(OPEN_KEY); const a = v ? JSON.parse(String(v)) : []; return Array.isArray(a) ? a.map((e) => (typeof e === "number" ? { plot: e, age: "AGE_ANTIQUITY" } : e)) : []; }, []); }

// the canal itself

const state = {
  enabled: true, originals: null, canalIndexes: new Set(), busy: new Set(),
  // canals opened in this session: their cliff faces are still drawn (a load redraws the hex without them)
  openedHere: new Set(),
  // canals whose hex is drawn as land this session: opened in it, or loaded as land (see keepLandLook)
  landMesh: new Set(), saving: false, hold: false, loading: false, pendingSave: false, syncing: false, localId: -1,
  multiplayer: false, paidTurn: -1, transits: new Map(), transitTurn: -1,
  // the age has ended (GameAgeEnded); the canals stay land for the transition
  ageEnded: false, repairing: false,
  // the autosave the mod's newest one pushes past the player's keep count, deleted once the new one is written
  prune: null,
  // canals a save held as Coast (Canals 1.0.0), turned to land as the game loaded
  staleLoad: [],
  // messages shown this session (a network game keeps no record of its own)
  told: new Set(),
  // the autosave to load once it is written (offerReload)
  reloadFrom: null
};

function canalIndex(v) { return state.canalIndexes.has(v); }

/** A save is being written, or is about to be: the save thread reads the map, and no map write may meet it. */
function saveInFlight() { return state.saving || state.pendingSave; }

/**
 * Map edits in one WorldBuilder block. The block is closed whatever fn does: left open by a throw, every later edit
 * of the session would sit inside it.
 */
function withBlock(fn) {
  let open = false;
  try { WorldBuilder.startBlock(); open = true; fn(); } finally { if (open) safe(() => WorldBuilder.endBlock()); }
}
const AGE_RANK = { AGE_ANTIQUITY: 1, AGE_EXPLORATION: 2, AGE_MODERN: 3 };
function ageRank(type) { return AGE_RANK[safe(() => String(GameInfo.Constructibles.lookup(type).Age), "")] || 0; }

export {
  AGE_RANK, BUILD_RADIUS, CANAL_TYPES, G, J, KEY, ONE_TILE, ONE_TILE_CANAL, OPEN_KEY, PLACE_MS, SETTLE_MS, ageRank,
  canalIndex, forget, loadOpen, loadPending, log, oneTileMode, remember, safe, saveInFlight, sleep, state, withBlock
};
