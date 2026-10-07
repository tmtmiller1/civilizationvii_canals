// Main menu side of Canals.
//
// While a game with an open canal runs, the mod holds the engine's autosave by storing its frequency as 1000 + the
// player's own value (see holdEngineAutosave in canals.js). This script runs whenever the main menu loads, after a
// game, a crash or a fresh start, and puts the player's value back, so the setting never outlives the game.

const AUTOSAVE_HELD = 1000;

try {
  const u = Configuration.getUser();
  const f = u.autoSaveFrequency;
  if (f >= AUTOSAVE_HELD) {
    u.setAutoSaveFrequency(Math.max(1, f - AUTOSAVE_HELD));
    console.error(`[Canals] autosave frequency back to the player's ${u.autoSaveFrequency} (was held at ${f})`);
  }
} catch (e) {
  console.error("[Canals] autosave restore threw " + e);
}
