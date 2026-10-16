// canals-look.js - Canals, game scope.
//
// The works dust over a site, the channel geometry and the drawn canal. Split out of canals.js (docs/split-plan.md).
"use strict";

import {
  RING, areaOf, currentAge, idx, isOpenWater, isSettlementCentre, isWater, locOf, neighborIn, openWaterSide,
  terrainOf
} from "./canals-map.js";
import { ONE_TILE, loadOpen, safe, state } from "./canals-state.js";

// the look, in-session
//
// A retyped hex keeps its land mesh until the next load (the engine redraws it as water then). Until then the
// canal is drawn by script from shipped meshes (runs c11 to c13, 2026-09-25): one river channel piece per
// water side, meeting at the hex center, a stone quay with cranes along the first arm, and moored river boats.
// The model group lives for the session; after a reload the engine's own water and quay take over.

const ARM_ASSET = "TER_Decal_RiverPiece_Straight";
const BOATS_ASSET = "IMP_FishingBoat_River_I_W_O_E";
/**
 * Per age, several looks; a canal takes the one its plot number selects, so it keeps that look across reloads.
 * Each entry: whether the river-city house layout is drawn (with which attachment set), and the props placed along
 * the first arm as [asset, along, left, scale]. Runs c16, c17 and c19 (2026-09-25) covered the harbors, the wharf,
 * the shipyard and the layouts; the pier B and Modern pier pieces are siblings of pieces seen there.
 */
const AGE_LOOKS = {
  AGE_ANTIQUITY: [
    { layout: false, props: [["GEN_ANT_Harbor_HB", 0.2, 0.25, 0.6], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.5]] },
    { layout: false, props: [["GEN_ANT_Harbor_Pier_HB", 0.15, 0.22, 0.55]] },
    { layout: false, props: [["GEN_ANT_Harbor_Pier_B_HB", 0.15, 0.22, 0.55], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.45]] },
  ],
  AGE_EXPLORATION: [
    { layout: true, attachments: "_Attachments", props: [["MED_SPN_Wharf_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_Attachments", props: [["MID_ABB_Shipyard_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_Attachments", props: [["MED_SPN_Wharf_HB", 0.2, 0.25, 0.5], ["GEN_ANT_Harbor_Pier_HB", -0.15, -0.22, 0.45]] },
  ],
  AGE_MODERN: [
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_HB", 0.2, 0.25, 0.55]] },
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_Pier_HB", 0.15, 0.22, 0.55]] },
    { layout: true, attachments: "_MOD_Attachments", decal: "_MOD_Decal", props: [["GEN_MOD_Harbor_HB", 0.2, 0.25, 0.5], ["GEN_MOD_Harbor_Pier_B_HB", -0.15, -0.22, 0.45]] },
  ],
};
const overlays = new Map();

// the works: an effect over the site while the tile is being changed
//
// The engine redraws the hex at each step of a commit and an opening (the improvement gives way to the boat; on a
// replaced quarter the houses and the district go and the rural tile comes). Nothing can hold those redraws back, so
// a plot effect is played over the site from the order until the canal is drawn and settled, and the swap reads as
// works in progress. The effect is the game's own wonder-construction dust, one instance at its own scale (three at
// double scale hazed five hexes, run vx5, 2026-10-08); empty switches it off.
let WORKS_VFX = "VFX_WON_BuildState_Change_Continuous_01";
const WORKS_MAX_MS = 20000;
const works = new Map();
function showWorks(loc) {
  const plot = idx(loc);
  if (!WORKS_VFX || works.has(plot) || typeof WorldUI === "undefined") return;
  const g = safe(() => WorldUI.createModelGroup("CanalsWorks_" + plot), null);
  if (!g) return;
  safe(() => g.addVFXAtPlot(WORKS_VFX, { x: loc.x, y: loc.y }, { x: 0, y: 0, z: 0 }, { scale: 1 }));
  works.set(plot, g);
  // never left behind: an opening that stalls still loses its works
  setTimeout(() => { if (works.get(plot) === g) hideWorks(loc); }, WORKS_MAX_MS);
}
function hideWorks(loc) {
  const g = works.get(idx(loc));
  if (g) { safe(() => g.clear()); safe(() => g.destroy()); works.delete(idx(loc)); }
}
/** The works effect by name, set through __canals.worksVfx; empty switches it off. */
function setWorksVfx(v) { WORKS_VFX = String(v || ""); }

/** Screen angle of a ring direction: the arm piece points east at 0 and turns counter-clockwise on screen. */
function armAngle(ringIndex) { return (360 - 60 * ringIndex) % 360; }

function waterSideIndexes(loc) {
  const out = [];
  RING.forEach((d, i) => { if (openWaterSide(loc, d)) out.push(i); });
  return out;
}

/** How far apart two ring directions are: 3 is straight across the hex, 1 is neighbouring sides. */
function ringGap(a, b) { const d = Math.abs(a - b) % 6; return Math.min(d, 6 - d); }

/** Ring indexes of opened canals beside the tile (queued ones are still land and get no arm until they open). */
function canalSideIndexes(loc) {
  const open = new Set(loadOpen().map((e) => e.plot));
  const out = [];
  RING.forEach((d, i) => { const n = neighborIn(loc, d); if (n && open.has(idx(n)) && isWater(n)) out.push(i); });
  return out;
}

/** The ways a ship can come in, as groups of ring indexes: each run of open water is one, each center another. */
function waysIn(loc, sides) {
  const water = RING.map((d, i) => sides.includes(i) && !!safe(() => isOpenWater(neighborIn(loc, d)), false));
  const groups = [];
  const start = water.every(Boolean) ? 0 : water.findIndex((w, i) => w && !water[(i + 5) % 6]);
  if (start >= 0) {
    let cur = null;
    for (let k = 0; k < 6; k++) {
      const i = (start + k) % 6;
      if (water[i]) { if (!cur) { cur = []; groups.push(cur); } cur.push(i); } else cur = null;
    }
  }
  for (const i of sides) if (!water[i]) groups.push([i]);
  return groups;
}

/**
 * The channel's arms. A canal is drawn as a channel between its shores, not as a spoke to every side: a tile with
 * water on five sides used to get five arms and read as a star. Now: one arm to each opened canal beside it, so a
 * run reads as one waterway and a Modern junction keeps its branches; a run's end adds the way in most nearly
 * opposite its canal; a single canal takes one way in from each of two different shores, as nearly opposite as the
 * hex allows.
 */
function channelSides(loc, water, links) {
  const beside = canalSideIndexes(loc).filter((i) => water.includes(i));
  const canal = links ? links.filter((i) => water.includes(i)) : beside;
  if (canal.length >= 2) return canal;
  const others = water.filter((i) => !beside.includes(i));
  if (!others.length) return canal;
  if (canal.length === 1) {
    const best = others.reduce((b, i) => (ringGap(i, canal[0]) > ringGap(b, canal[0]) ? i : b), others[0]);
    return [canal[0], best].sort((a, b) => a - b);
  }
  let pairs = shorePairs(loc, others);
  if (!pairs.length) {
    if (others.length <= 2) return others;
    pairs = everyPair(others);
  }
  pairs.sort((p, q) => ringGap(q[0], q[1]) - ringGap(p[0], p[1]) || (p[0] + p[1]) - (q[0] + q[1]));
  return pairs[0].slice().sort((a, b) => a - b);
}

/** Every two sides of the list, in order. */
function everyPair(sides) {
  const pairs = [];
  for (let g = 0; g < sides.length; g++) for (let h = g + 1; h < sides.length; h++) pairs.push([sides[g], sides[h]]);
  return pairs;
}

/** The pairs of sides a channel may join: one from each of two ways in. */
function shorePairs(loc, others) {
  const groups = waysIn(loc, others);
  if (groups.length < 2) {
    // one continuous shore that holds two bodies of water (qualified by area, not by stretch): split by area
    const area = (i) => areaOf(neighborIn(loc, RING[i]));
    return everyPair(others).filter(([a, b]) => area(a) !== area(b));
  }
  const pairs = [];
  for (let g = 0; g < groups.length; g++) for (let h = g + 1; h < groups.length; h++)
    for (const i of groups[g]) for (const j of groups[h]) pairs.push([i, j]);
  return pairs;
}

/** The opened canal tiles joined to this one, itself included: one waterway, drawn as one. */
function runOf(loc) {
  const open = new Set(loadOpen().map((e) => e.plot));
  const start = idx(loc);
  if (!open.has(start)) return [loc];
  const seen = new Set([start]); const out = [loc]; const queue = [loc];
  while (queue.length) {
    const c = queue.pop();
    for (const d of RING) {
      const n = neighborIn(c, d); if (!n) continue;
      const p = idx(n);
      if (seen.has(p) || !open.has(p) || !isWater(n)) continue;
      seen.add(p); out.push(n); queue.push(n);
    }
  }
  return out;
}

/**
 * Which neighbouring canal each tile of a run is drawn joined to: a tree grown from the tile where the most canals
 * meet. Every canal is joined to the run, and a crossroads reads as a cross; without it the arm tiles of a junction,
 * which touch each other too, were drawn joined all round and the crossing filled in as a blob. Drawing only: ships
 * cross between any two canal tiles that touch.
 */
function runLinks(run) {
  const plots = new Set(run.map(idx));
  const nb = new Map(run.map((t) => [idx(t), RING.map((d, i) => {
    const n = neighborIn(t, d); return n && plots.has(idx(n)) ? i : -1;
  }).filter((i) => i >= 0)]));
  const hub = run.slice().sort((a, b) => nb.get(idx(b)).length - nb.get(idx(a)).length || idx(a) - idx(b))[0];
  const links = new Map(run.map((t) => [idx(t), []]));
  const seen = new Set([idx(hub)]); const queue = [hub];
  while (queue.length) {
    const c = queue.shift();
    for (const i of nb.get(idx(c))) {
      const n = neighborIn(c, RING[i]); const p = idx(n);
      if (seen.has(p)) continue;
      seen.add(p); queue.push(n);
      links.get(idx(c)).push(i); links.get(p).push((i + 3) % 6);
    }
  }
  for (const a of links.values()) a.sort((x, y) => x - y);
  return links;
}

const MAX_ARMS_WITH_BRANCH = 4;
/**
 * The arms of every tile of a run, decided for the run as a whole. Each tile starts from its own channel (see
 * channelSides). Then the water around the run is grouped into shores - its tiles joined where two of them touch and
 * hold the same body of water - and a shore that no arm reaches gets one branch, from the one tile and side that
 * crowd the picture least: fewest arms, no cliff on that edge (a branch into a lake over a lock reads as a wall), the
 * widest angle to the tile's other arms. Without the branch a lake beside a canal looked cut off although ships cross
 * between them (the user's capture, c56: a lake touching both tiles of a two-tile cut, both of its sides pruned). Open
 * sea around a tile is one shore, which the channel already reaches, so it gets no spokes.
 * The one exception is a junction: where several canals meet on one tile (Modern), an arm runs to every one of them,
 * and such a tile takes a branch only while it has fewer than four arms. This is the drawing only; where canals may
 * be built is decided by isIsthmus.
 */
function runArms(run) {
  const open = new Map(loadOpen().map((e) => [e.plot, e]));
  const inRun = new Set(run.map(idx));
  const arms = new Map();
  const touch = [];
  const links = runLinks(run);
  for (const t of run) {
    const water = waterSideIndexes(t);
    arms.set(idx(t), channelSides(t, water, links.get(idx(t))));
    touch.push(...shoreTouches(t, water, inRun, (open.get(idx(t)) || {}).cliffs || []));
  }
  branchToShores(touch, arms);
  return arms;
}

/** One branch to each shore no arm reaches yet, added to `arms`. */
function branchToShores(touch, arms) {
  const wp = [...new Set(touch.map((x) => x.w))];
  const find = shoreOf(wp);
  const reached = new Set(touch.filter((x) => arms.get(x.plot).includes(x.side)).map((x) => find(x.w)));
  for (const shore of [...new Set(wp.map(find))]) {
    if (reached.has(shore)) continue;
    const best = branchFor(touch.filter((x) => find(x.w) === shore), arms);
    if (best) { arms.set(best.plot, [...arms.get(best.plot), best.side].sort((a, b) => a - b)); reached.add(shore); }
  }
}

/** A run tile's water sides that face water outside the run, each as { plot, side, w (the water's plot), cliff }. */
function shoreTouches(t, water, inRun, cliffs) {
  const out = [];
  for (const i of water) {
    const n = neighborIn(t, RING[i]);
    if (n && !inRun.has(idx(n))) out.push({ plot: idx(t), side: i, w: idx(n), cliff: cliffs.includes(i) });
  }
  return out;
}

/** The water plots around a run joined into shores: two touching plots of the same body of water are one shore (a
 * settlement centre joins none). Returns the lookup from a plot to its shore. */
function shoreOf(wp) {
  const parent = new Map(wp.map((p) => [p, p]));
  const find = (p) => { while (parent.get(p) !== p) p = parent.get(p); return p; };
  for (let a = 0; a < wp.length; a++) for (let b = a + 1; b < wp.length; b++) {
    const A = locOf(wp[a]), B = locOf(wp[b]);
    if (isSettlementCentre(A) || isSettlementCentre(B)) continue;
    if (safe(() => GameplayMap.getPlotDistance(A.x, A.y, B.x, B.y), 9) !== 1 || areaOf(A) !== areaOf(B)) continue;
    parent.set(find(wp[a]), find(wp[b]));
  }
  return find;
}

/** Of one shore's touches, the one to branch from: fewest arms, no cliff, the widest angle to the tile's arms. */
function branchFor(touches, arms) {
  const key = (x) => {
    const a = arms.get(x.plot);
    const gap = a.length ? Math.min(...a.map((i) => ringGap(i, x.side))) : 3;
    return [a.length, x.cliff ? 1 : 0, -gap, x.plot, x.side];
  };
  // A tile never takes a branch that would give it a fifth arm: a junction's canals always meet on it (never
  // pruned, however many there are), but a branch on top of four would read as a star again.
  const room = (x) => arms.get(x.plot).length < MAX_ARMS_WITH_BRANCH;
  return touches.filter(room).sort((p, q) => {
    const a = key(p), b = key(q);
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k];
    return 0;
  })[0];
}

/**
 * The order the arms are drawn in: first the arm whose left-hand sector (the previous ring direction) is dry land,
 * so the props and the house layout, which sit to the left of the first arm, stand on a bank and never in water.
 * `water` is every water side of the tile, drawn or not.
 */
function orderSides(sides, water) {
  if (sides.length < 2) return sides;
  // "left" of an arm (alongArm's +y) is counter-clockwise on screen, which is the previous ring index
  // (armAngle turns counter-clockwise as the index falls); c32: the props sat on the next arm with +1.
  let k = sides.findIndex((i) => !(water || sides).includes((i + 5) % 6));
  if (k < 0) k = sides.findIndex((i) => !sides.includes((i + 5) % 6));
  return k <= 0 ? sides : sides.slice(k).concat(sides.slice(0, k));
}

/** The river-city layout whose corridor best fits the first two shores, to be rotated onto the first shore. */
function layoutFor(sides) {
  if (sides.length < 2) return "River_City_I_W_O_E";
  const diff = (sides[1] - sides[0] + 6) % 6;
  return diff === 3 ? "River_City_I_W_O_E" : diff === 4 ? "River_City_I_NW_O_E" : diff === 2 ? "River_City_I_SW_O_E" : "River_City_I_W_O_E";
}

/** Rotate an offset given in the first arm's frame (x along the arm, y to its left) into world offsets. */
function alongArm(angleDeg, x, y) {
  const a = angleDeg * Math.PI / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a), z: 0 };
}

/**
 * A lock where a channel meets a shore that was a cliff (the rock faces stay drawn after the retype, so the canal
 * is dressed as stepping down through them): a stone chamber with gates across the channel, a gatehouse on one
 * bank and a water wheel on the other. Pieces as [asset, along the arm, to its left, scale, angle offset].
 * Runs c29 and c30 (2026-09-25): further out than 0.42 the chamber vanishes into the cliff mesh. The looping
 * waterfall effect that stood past the lock (c34) is gone: from the game camera it read as a white spray standing up
 * out of the sea (lab c63).
 */
const LOCK_PIECES = [
  ["IMP_Saqiya_Canal_Decal_Straight_A", 0.42, 0, 1, 0],
  ["MED_CRT_Dockyard_Gate_HB", 0.42, 0.17, 0.5, 0],
  ["NEU_NOR_Gristmill_WaterWheel", 0.36, -0.16, 0.5, 0],
];

/**
 * The middle of the widest stretch of bank between a tile's arms, as a screen angle, and its width in ring steps (6
 * for a tile with one arm). A junction's quay stands there, clear of every channel.
 */
function widestBank(sides) {
  const s = sides.slice().sort((a, b) => a - b);
  if (s.length < 2) return { angle: (armAngle(s[0]) + 180) % 360, gap: 6 };
  let best = { angle: 0, gap: 0 };
  for (let k = 0; k < s.length; k++) {
    const a = s[k], gap = (s[(k + 1) % s.length] - a + 6) % 6 || 6;
    // ring indexes run clockwise on screen and angles counter-clockwise, so the bank after arm a lies below a's angle
    if (gap > best.gap) best = { angle: (armAngle(a) - 30 * gap + 360) % 360, gap };
  }
  return best;
}

/**
 * Locks, one per arm that meets natural water over a cliff. An edge between two canal tiles gets none: at a
 * crossroads every arm of the middle tile faced a cliff, and four chambers with their gatehouses and wheels closed
 * into a square stone pool (lab c63).
 */
function drawLocks(add, sides, cliffs, beside) {
  for (const i of sides) {
    if (!cliffs.includes(i) || beside.includes(i)) continue;
    const a = armAngle(i);
    for (const [asset, x, y, scale, rot] of LOCK_PIECES) add(asset, alongArm(a, x, y), scale, (a + rot) % 360);
  }
}

/**
 * The quay and harbour props. Along a channel they stand to the left of the first arm (see orderSides); a junction
 * takes the first one alone, set back on its widest bank and facing the water, since along an arm it stood in the
 * next channel.
 */
function drawProps(add, look, sides, a0) {
  if (sides.length < 3) {
    for (const [asset, x, y, scale] of look.props) add(asset, alongArm(a0, x, y), scale, a0);
    return;
  }
  const [asset, , , scale] = look.props[0];
  const bank = widestBank(sides);
  add(asset, alongArm(bank.angle, bank.gap >= 3 ? 0.3 : 0.24, 0), scale, (bank.angle + 90) % 360);
}

function drawOverlay(loc, age, cliffs) {
  const plot = idx(loc);
  if (overlays.has(plot) || typeof WorldUI === "undefined" || typeof PlacementMode === "undefined") return false;
  const water = waterSideIndexes(loc);
  if (!water.length) return false;
  const sides = orderSides(runArms(runOf(loc)).get(plot) || channelSides(loc, water), water);
  if (!sides.length) return false;
  // A one-tile canal takes the look of the age being played, so it is redrawn in each new age's style; an age
  // Canal keeps the look of the age it was dug in.
  const look = (AGE_LOOKS[age === ONE_TILE ? currentAge() : age] || AGE_LOOKS.AGE_ANTIQUITY)[plot % 3];
  const group = safe(() => WorldUI.createModelGroup("Canals_" + plot), null);
  if (!group) return false;
  drawCanal(modelAdder(group, loc), { loc, plot, look, sides, water, cliffs });
  overlays.set(plot, group);
  return true;
}

/** add(asset, offset, scale, angle): one model on the tile, following the terrain. */
function modelAdder(group, loc) {
  const plotRef = { i: loc.x, j: loc.y };
  return (asset, off, scale, angle) => safe(() => group.addModelAtPlot(asset, plotRef, off || { x: 0, y: 0, z: 0 },
    { placement: PlacementMode.TERRAIN, followTerrain: true, needsShadows: true, scale, angle }));
}

/** The canal's models, in the order they're added: the house layout, the arms, the locks, the quay, the boats. */
function drawCanal(add, c) {
  const a0 = armAngle(c.sides[0]);
  drawLayout(add, c, a0);
  for (const i of c.sides) add(ARM_ASSET, null, 1, armAngle(i));
  if (state.openedHere.has(c.plot) && c.cliffs && c.cliffs.length)
    drawLocks(add, c.sides, c.cliffs, canalSideIndexes(c.loc));
  drawProps(add, c.look, c.sides, a0);
  // Boats on the tiles that meet open water or a junction; a straight middle reach of a longer canal stays clear.
  const s = c.sides;
  if (s.length !== 2 || (s[1] - s[0] + 6) % 6 !== 3 || c.plot % 2 === 0) add(BOATS_ASSET, null, 0.7, a0);
}

function drawLayout(add, c, a0) {
  // A canal saved as Coast is drawn by the next load as shallow sea, where whatever stood on a bank would stand in the
  // water (the house layout read as a drowned street, lab c64). Canals are saved as land now (keepLandLook), so that
  // happens only to a canal from a save made before this version, until it is saved again. The cliff faces the locks
  // dress are drawn only until the next load, whatever the terrain.
  const landMesh = state.landMesh.has(c.plot);
  // The house layout is a corridor between two shores; a junction of three or more channels gets none, and nor does
  // a tile with water all round, where the houses would stand on no bank.
  if (!(landMesh && c.look.layout && c.sides.length <= 2 && c.water.length <= 2)) return;
  const L = layoutFor(c.sides); add(L, null, 1, a0);
  if (c.look.attachments) add(L + c.look.attachments, null, 1, a0);
  if (c.look.decal) add(L + c.look.decal, null, 1, a0);
}

function clearOverlay(loc) {
  const g = overlays.get(idx(loc));
  if (g) { safe(() => g.clear()); safe(() => g.destroy()); overlays.delete(idx(loc)); }
}

/**
 * A canal that has just opened is water now: the rest of its run is redrawn, so the channels meet it and a branch
 * into a shore can move to whichever tile now suits it best.
 */
function redrawNeighbours(loc) {
  const open = new Map(loadOpen().map((e) => [e.plot, e]));
  let n = 0;
  for (const t of runOf(loc)) {
    const p = idx(t);
    if (p === idx(loc) || !open.has(p) || terrainOf(t) !== "TERRAIN_COAST") continue;
    clearOverlay(t);
    if (drawOverlay(t, open.get(p).age, open.get(p).cliffs)) n++;
  }
  return n;
}

export {
  WORKS_VFX, channelSides, clearOverlay, drawOverlay, hideWorks, redrawNeighbours, runArms, runOf, setWorksVfx,
  showWorks, waterSideIndexes, works
};
