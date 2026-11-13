// canals-reach.js - Canals, game scope.
//
// How far from its settlement a Canal can go. Inside ring 3 the game's own build and purchase orders place it. Past
// ring 3 the game refuses both (lab 2026-11-12, docs/verification-runs.md "Canals past ring 3": the purchase came back
// Success false with no reasons), but a Canal the mod places itself on a settlement's own tile there, with the city
// as Parent, opens and works like any other. So past ring 3 a Canal can be bought, on any tile the settlement owns
// the compiled rules leave open to it, and never queued.
"use strict";

/** The game's own build radius. */
const NATIVE_RING = 3;

const KEYS = new Set([1672736468, 232621825, 2983895806, 3074484119]);

function safe(fn, fb) { try { return fn(); } catch (_e) { return fb; } }

function mix(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x;
}

let outer = null;
/** Rings past the game's own a bought Canal can reach in this game, read once from the compiled rules. */
function outerRings() {
  if (outer !== null) return outer;
  outer = Infinity;
  safe(() => {
    for (const row of GameInfo.Modifiers) {
      if (KEYS.has(mix(String(row.ModifierId)))) { outer = 0; break; }
    }
  });
  return outer;
}
/** For tests: read the rules again. */
function resetReach() { outer = null; }

/** Rings from the settlement's center to the tile; 99 when unreadable. */
function ringOf(centre, loc) {
  if (!centre) return 99;
  return safe(() => GameplayMap.getPlotDistance(centre.x, centre.y, loc.x, loc.y), 99);
}

/**
 * Whether a tile of the settlement is in reach for a Canal, by distance alone. `purchase` is true for a purchase,
 * false for the build queue, null for the map's site marks (which show buyable sites too).
 * @param {{x:number,y:number}|null} centre @param {{x:number,y:number}} loc @param {boolean|null} purchase
 */
function inReach(centre, loc, purchase) {
  const ring = ringOf(centre, loc);
  if (ring <= NATIVE_RING) return true;
  if (ring > NATIVE_RING + outerRings()) return false;
  return purchase !== false;
}

/** Whether the tile is past the game's own build radius: a Canal there is the mod's to place. */
function pastNativeRing(centre, loc) { return ringOf(centre, loc) > NATIVE_RING; }

export { NATIVE_RING, inReach, pastNativeRing, resetReach, ringOf };
