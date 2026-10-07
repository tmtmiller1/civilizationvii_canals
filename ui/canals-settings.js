// canals-settings.js - which canal rules are in play.
//
// "ages" is the mod as it has always been: each age's Canal, its tech, its run rule and its ship limit. "one-tile" is
// the alternative a player can choose in Options > Add-ons: one Canal, the same in every age, always a single tile, no
// ship limit (see ui/canals.js).
//
// The value lives in the shared "modSettings" localStorage entry, the store Tower's other mods use, and in-game also in
// the save (GameConfiguration). In a game the save's copy wins, so a game keeps the rules it was played with whatever
// the main menu says later; the main-menu value is the default for new games. canals.js writes the copy into the save
// when a game starts without one. No imports and nothing cached: the Options screen and the game run in separate
// script contexts, and every read goes to the store.

export const MOD_ID = "tower-canals";
export const MODE_KEY = "mode";
export const MODES = ["ages", "one-tile"];
const DEFAULT_MODE = "ages";
const GC_KEY = "ModOptions_" + MOD_ID;

/** The save's copy of the mod's options, or null (main menu, or a save that has none). */
function gameOptions() {
  let raw = null;
  try {
    raw = Configuration.getGame().getValue(GC_KEY);
  } catch (_) {
    return null;
  }
  try {
    const o = typeof raw === "string" && raw.length ? JSON.parse(raw) : null;
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}

/**
 * The shared entry, for a write. Coherent's getItem() can return the first key in the store instead of the one asked
 * for, so a write goes ahead only when what came back looks like a settings root ({ "<modId>": {...}, ... }), never
 * over another mod's data.
 */
function sharedForWrite() {
  let raw = null;
  try {
    raw = localStorage.getItem("modSettings");
    if (!raw) raw = localStorage.getItem("modSettings"); // a first read can come back empty
  } catch (_) {
    return { root: {}, safe: false };
  }
  if (!raw) return { root: {}, safe: true };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { root: {}, safe: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { root: {}, safe: false };
  const root = Object.keys(parsed).every((k) => !!parsed[k] && typeof parsed[k] === "object" && !Array.isArray(parsed[k]));
  return root ? { root: parsed, safe: true } : { root: {}, safe: false };
}

/** The main menu's value: the default for a game with no copy of its own. */
function sharedMode() {
  try {
    const v = JSON.parse(localStorage.getItem("modSettings") || "null")?.[MOD_ID]?.[MODE_KEY];
    return MODES.includes(v) ? v : null;
  } catch (_) {
    return null;
  }
}

/** @returns {"ages"|"one-tile"} The rules in play: the save's, else the main menu's, else by age. */
export function getMode() {
  const v = gameOptions()?.[MODE_KEY];
  if (MODES.includes(v)) return v;
  return sharedMode() || DEFAULT_MODE;
}

/** @returns {boolean} Whether a game holds its own copy of the mode. */
export function gameHasMode() {
  return MODES.includes(gameOptions()?.[MODE_KEY]);
}

/** Write the copy into the save only (a game that started without one keeps the rules it started with). */
export function pinModeToGame(mode) {
  if (!MODES.includes(mode)) return;
  try {
    const edit = typeof Configuration !== "undefined" ? Configuration.editGame?.() : null;
    if (!edit || typeof edit.setValue !== "function") return;
    const all = gameOptions() || {};
    all[MODE_KEY] = mode;
    edit.setValue(GC_KEY, JSON.stringify(all));
  } catch (_) {
    /* the main menu: there is no game to write to */
  }
}

/** Set the mode: the main menu's default, and in a game that game's own. */
export function setMode(mode) {
  if (!MODES.includes(mode)) return;
  try {
    const { root, safe } = sharedForWrite();
    if (safe) {
      (root[MOD_ID] ??= {})[MODE_KEY] = mode;
      localStorage.setItem("modSettings", JSON.stringify(root));
    }
  } catch (_) {
    /* ignore */
  }
  pinModeToGame(mode);
}
