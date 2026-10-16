// canals-rule.js - Canals, game scope.
//
// The site rule (isIsthmus) and what a canal is worth to the AI (canalWorth). Split out of canals.js (docs/split-
// plan.md).
"use strict";

import {
  RING, currentAge, idx, isCuttable, isOpenWater, isShipWater, locOf, neighborIn, neighbors, waterStretches
} from "./canals-map.js";
import { ONE_TILE_CANAL, loadOpen, loadPending, oneTileMode } from "./canals-state.js";

/** Most tiles a canal run may have, by age. */
const CHAIN_RULES = {
  AGE_ANTIQUITY: { max: 1 },
  AGE_EXPLORATION: { max: 2 },
  AGE_MODERN: { max: 5 }
};
const ONE_TILE_RULE = CHAIN_RULES.AGE_ANTIQUITY;

/** The rule a Canal of this type is judged by: the one-tile Canal by its own, the age Canals by the age in play. */
function ruleFor(type) {
  if (type === ONE_TILE_CANAL) return ONE_TILE_RULE;
  return CHAIN_RULES[currentAge()] || CHAIN_RULES.AGE_ANTIQUITY;
}
function placementRule() { return ruleFor(oneTileMode() ? ONE_TILE_CANAL : ""); }

/** Plots that are canal tiles: opened ones (now coast) and queued ones (still land, counted so canals can be built
    in sequence). */
function canalPlots() {
  const s = new Set();
  for (const e of loadOpen()) s.add(e.plot); for (const p of loadPending()) s.add(p);
  return s;
}

function isNaturalWater(loc, canals) { return isShipWater(loc) && !canals.has(idx(loc)); }

/**
 * The placement rule: a cuttable land tile that touches ship water, so the new water joins water a ship can reach.
 * Beside a canal (opened or queued) the tile joins that canal's run, and the run may have at most the age's number
 * of tiles (one in Antiquity, two in Exploration, five in Modern), every tile of it reaching natural water through
 * the run. A longer cut is dug from the shore inward, one tile at a time; where it goes, and whether it ever meets
 * the far shore, is the player's call. One-tile mode: Antiquity's rule, in every age. `rule` defaults to the rule for
 * a new Canal; a finished one is judged by the rule of its own type (ruleFor).
 * A tile beside a canal is judged by the run rule, never as a shore tile of its own: a canal's own water does not
 * make its neighbor a site outside the run's length (gal-exp).
 */
function isIsthmus(loc, rule = placementRule()) {
  if (!isCuttable(loc)) return false;
  const canals = canalPlots();
  const besideCanal = RING.some((d) => { const n = neighborIn(loc, d); return n && canals.has(idx(n)); });
  if (!besideCanal) return waterStretches(loc) >= 1;
  if (rule.max <= 1) return false;
  const comp = runJoined(loc, canals);
  if (comp.size > rule.max) return false;
  return reachesNaturalWater(comp, canals);
}

/** The run of canal tiles a tile would join: its plot and every canal plot connected to it. */
function runJoined(loc, canals) {
  const comp = new Set([idx(loc)]); const queue = [loc];
  while (queue.length) {
    const c = queue.pop();
    for (const d of RING) {
      const n = neighborIn(c, d); if (!n) continue;
      const p = idx(n); if (canals.has(p) && !comp.has(p)) { comp.add(p); queue.push(n); }
    }
  }
  return comp;
}

/** Every tile of the run reaches natural water through the run. */
function reachesNaturalWater(comp, canals) {
  const besideWater = (l) => RING.some((d) => { const n = neighborIn(l, d); return n && isNaturalWater(n, canals); });
  const q2 = [...comp].filter((p) => besideWater(locOf(p)));
  const dist = new Map(q2.map((p) => [p, 1]));
  while (q2.length) {
    const p = q2.shift(); const l = locOf(p);
    for (const d of RING) {
      const n = neighborIn(l, d); if (!n) continue;
      const np = idx(n); if (comp.has(np) && !dist.has(np)) { dist.set(np, dist.get(p) + 1); q2.push(np); }
    }
  }
  for (const p of comp) if (!dist.has(p)) return false;
  return true;
}

// What a canal is worth, in tiles of sailing. Two shores of the same sea: the tiles a ship saves by cutting through
// instead of sailing round. Two separate bodies of water: the size of the smaller one, since that is what the cut
// opens up. A search that goes AI_WORTH_REACH tiles without meeting the far shore counts as that far round.
const AI_MIN_SAVING = 6;
const AI_MIN_BODY = 10;
const AI_WORTH_REACH = 30;

/** The runs of open water around the hex, in ring order, each a list of its water tiles. */
function waterSides(loc) {
  const ring = RING.map((d) => neighborIn(loc, d));
  const water = ring.map((n) => !!(n && isOpenWater(n)));
  if (water.every(Boolean)) return [ring];
  const start = water.findIndex((w) => !w);
  const sides = []; let cur = null;
  for (let k = 1; k <= 6; k++) {
    const i = (start + k) % 6;
    if (water[i]) { if (!cur) sides.push(cur = []); cur.push(ring[i]); } else cur = null;
  }
  return sides;
}

/** Breadth-first over open water from the given tiles (never through `avoid`): distance by plot, and whether the
 * search ran out of water before `reach`. */
function sailFrom(tiles, avoid, reach) {
  const dist = new Map(); let frontier = [];
  for (const t of tiles) { const p = idx(t); if (!dist.has(p)) { dist.set(p, 0); frontier.push(t); } }
  for (let d = 1; d <= reach && frontier.length; d++) {
    const next = [];
    for (const t of frontier) {
      for (const n of neighbors(t)) {
        const p = idx(n);
        if (p === avoid || dist.has(p) || !isOpenWater(n)) continue;
        dist.set(p, d); next.push(n);
      }
    }
    frontier = next;
  }
  return { dist, closed: frontier.length === 0 };
}

/** The worth of joining shore B to the water already searched from shore A (`from`), with the reason. */
function pairWorth(from, sideB, me) {
  const hit = sideB.map((t) => from.dist.get(idx(t))).filter((d) => d != null);
  if (hit.length) {
    // shore to shore round the water, against two steps through the cut
    const saves = Math.min(...hit) - 2;
    return { worth: saves >= AI_MIN_SAVING ? saves : 0, why: `saves ${saves}` };
  }
  const far = sailFrom(sideB, me, AI_WORTH_REACH);
  const small = Math.min(from.closed ? from.dist.size : Infinity, far.closed ? far.dist.size : Infinity);
  if (small === Infinity) return { worth: AI_WORTH_REACH, why: "far round" };
  return { worth: small >= AI_MIN_BODY ? Math.min(small, AI_WORTH_REACH) : 0, why: `joins a body of ${small}` };
}

/**
 * The best worth of a cut here over every pair of its shores, with the reason. 0 when no pair is worth digging: a
 * pond, or two shores already a short sail apart.
 */
function canalWorth(loc) {
  const sides = waterSides(loc);
  if (sides.length < 2) return { worth: 0, why: "one shore" };
  const me = idx(loc); let best = null;
  for (let a = 0; a < sides.length - 1; a++) {
    const from = sailFrom(sides[a], me, AI_WORTH_REACH);
    for (let b = a + 1; b < sides.length; b++) {
      const w = pairWorth(from, sides[b], me);
      if (!best || w.worth > best.worth) best = w;
    }
  }
  return best;
}

export { canalWorth, isIsthmus, ruleFor, waterSides };
