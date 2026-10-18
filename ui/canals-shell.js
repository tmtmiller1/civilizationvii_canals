// Main menu side of Canals.
//
// Up to 1.5.5, while a game with an open canal ran, the mod held the engine's autosave by storing its frequency as
// 1000 + the player's own value. The setting is the player's, so a value left that way by an older version is put
// back whenever the main menu loads, after a game, a crash or a fresh start.

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
