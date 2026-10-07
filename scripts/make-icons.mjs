// make-icons.mjs - draws the three Canal building icons (Ancient, Medieval, Modern) in the game's building-icon frame:
// a gold-rimmed medallion over a navy dusk sky, looking down the channel toward the sea it opens onto. The ages share
// the frame and the view and differ in banks, gates and ship, the way the base game's walls and bridges do.
// Writes art/canal-<age>.svg and icons/building_canal_<age>_<size>.png (256, 128, 64). Needs rsvg-convert.
//   node scripts/make-icons.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [256, 128, 64];
const C = 128;          // medallion centre
const HZ = 112;         // horizon
const f = (n) => Math.round(n * 10) / 10;
const pts = (a) => a.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

// The channel in perspective: s = 0 at the horizon, 1 near the bottom of the frame, beyond 1 out of frame.
const water = (side, s) => [C + side * (12 + 58 * s), HZ + 144 * s];
const wallH = (age) => ({ ancient: 58, medieval: 66, modern: 72 }[age]);
const coping = (age, side, s) => { const [x, y] = water(side, s); return [x, y - wallH(age) * s]; };
const SS = [0, 0.08, 0.17, 0.28, 0.42, 0.6, 0.82, 1.08, 1.45];

function frameDefs(id) {
  return `
    <radialGradient id="sky${id}" cx="50%" cy="85%" r="75%">
      <stop offset="0" stop-color="#9a8ede"/><stop offset="0.45" stop-color="#4a44a4"/><stop offset="1" stop-color="#232158"/>
    </radialGradient>
    <linearGradient id="gold${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbe7a6"/><stop offset="0.35" stop-color="#d9a94b"/>
      <stop offset="0.7" stop-color="#9c6d22"/><stop offset="1" stop-color="#e8c26a"/>
    </linearGradient>
    <linearGradient id="sea${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5d7fb8"/><stop offset="1" stop-color="#2d4f86"/>
    </linearGradient>
    <linearGradient id="chan${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f78ae"/><stop offset="0.5" stop-color="#2a5783"/><stop offset="1" stop-color="#173a5c"/>
    </linearGradient>
    <linearGradient id="haze${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2760" stop-opacity="0.75"/><stop offset="1" stop-color="#2a2760" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vig${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0.68" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#14123a" stop-opacity="0.42"/>
    </radialGradient>
    <radialGradient id="glow${id}" cx="50%" cy="100%" r="60%">
      <stop offset="0" stop-color="#b9a6e8" stop-opacity="0.55"/><stop offset="1" stop-color="#b9a6e8" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="disc${id}"><circle cx="${C}" cy="${C}" r="114"/></clipPath>`;
}

function frame(id) {
  return `
  <circle cx="${C}" cy="${C}" r="119" fill="none" stroke="#3a2608" stroke-width="12"/>
  <circle cx="${C}" cy="${C}" r="119" fill="none" stroke="url(#gold${id})" stroke-width="9"/>
  <circle cx="${C}" cy="${C}" r="114.5" fill="none" stroke="#2b1a05" stroke-width="1.6" opacity="0.8"/>
  <circle cx="${C}" cy="${C}" r="123.5" fill="none" stroke="#fff3c4" stroke-width="0.8" opacity="0.6"/>`;
}

/** Far shore, the open sea at the channel's mouth and the two banks' tops. */
function landscape(age, id) {
  const land = { ancient: ["#93a24c", "#6f7e36"], medieval: ["#87954a", "#636f33"], modern: ["#a2a299", "#7c7c73"] }[age];
  const far = `<path d="M-10 ${HZ - 6} Q 30 ${HZ - 20} 70 ${HZ - 9} T 150 ${HZ - 12} T 266 ${HZ - 8} V ${HZ - 4} H -10 Z" fill="#3c3f63"/>`;
  const sea = `<rect x="-10" y="${HZ - 5}" width="276" height="6" fill="url(#sea${id})"/>`;
  const bank = (side) => {
    const edge = SS.map((s) => coping(age, side, s));
    const outer = side < 0 ? [[-10, 300], [-10, HZ]] : [[266, 300], [266, HZ]];
    return `<polygon points="${pts([...edge, ...outer])}" fill="${land[0]}"/>` +
      `<polygon points="${pts([...edge.slice(3), [edge[edge.length - 1][0] + side * 60, 300]])}" fill="${land[1]}" opacity="0.35"/>`;
  };
  return far + sea + bank(-1) + bank(1);
}

/** The channel water and the two bank walls, coursed per age. */
function channel(age, id) {
  const wall = { ancient: ["#bfae90", "#7e6f56"], medieval: ["#d2c7b0", "#8d8268"], modern: ["#deded7", "#9a9a92"] }[age];
  const w = [...SS.map((s) => water(-1, s)), ...SS.slice().reverse().map((s) => water(1, s))];
  let out = `<polygon points="${pts(w)}" fill="url(#chan${id})"/>`;
  for (const side of [-1, 1]) {
    const face = [...SS.map((s) => water(side, s)), ...SS.slice().reverse().map((s) => coping(age, side, s))];
    out += `<polygon points="${pts(face)}" fill="${wall[0]}"/>`;
    // courses: lines along the wall at fractions of its height
    const courses = age === "modern" ? [0.5] : age === "medieval" ? [0.25, 0.5, 0.75] : [0.33, 0.66];
    for (const k of courses) {
      const line = SS.map((s) => { const [x, y] = water(side, s); return [x, y - wallH(age) * s * k]; });
      out += `<polyline points="${pts(line)}" fill="none" stroke="${wall[1]}" stroke-width="${age === "modern" ? 1.2 : 1.4}"/>`;
    }
    // joints: vertical lines, staggered by course for stone, sparse panels for concrete
    const joints = age === "modern" ? [0.2, 0.45, 0.8, 1.25] : [0.1, 0.2, 0.3, 0.38, 0.5, 0.62, 0.75, 0.9, 1.05, 1.25];
    joints.forEach((s, i) => {
      const [x, y] = water(side, s); const h = wallH(age) * s;
      const n = courses.length + 1;
      for (let c = 0; c < n; c++) {
        if (age !== "modern" && (i + c) % 2) continue;
        const y0 = y - h * (c / n), y1 = y - h * ((c + 1) / n);
        out += `<line x1="${f(x)}" y1="${f(y0)}" x2="${f(x)}" y2="${f(y1)}" stroke="${wall[1]}" stroke-width="${f(0.6 + s)}"/>`;
      }
    });
    // the wall's top edge
    out += `<polyline points="${pts(SS.map((s) => coping(age, side, s)))}" fill="none" stroke="${age === "modern" ? "#e6e6df" : "#d8ccb0"}" stroke-width="2"/>`;
  }
  // light on the water
  out += `<g stroke="#9cc3e8" stroke-linecap="round" opacity="0.7">
    <line x1="120" y1="132" x2="130" y2="132" stroke-width="1.2"/><line x1="112" y1="150" x2="126" y2="150" stroke-width="1.5"/>
    <line x1="134" y1="160" x2="146" y2="160" stroke-width="1.5"/><line x1="98" y1="236" x2="118" y2="236" stroke-width="2.2"/>
    <line x1="146" y1="244" x2="170" y2="244" stroke-width="2.2"/></g>`;
  return out;
}

// per-age dressing

function torch(x, y, h) {
  return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y - h}" stroke="#4a2f17" stroke-width="${f(h / 9)}"/>` +
    `<ellipse cx="${x}" cy="${f(y - h - h * 0.12)}" rx="${f(h * 0.09)}" ry="${f(h * 0.17)}" fill="#ffb13b"/>` +
    `<ellipse cx="${x}" cy="${f(y - h - h * 0.1)}" rx="${f(h * 0.045)}" ry="${f(h * 0.09)}" fill="#fff0a8"/>`;
}

function galley() {
  // stern view: dark hull, curled sternpost, red-striped square sail, oars on both sides
  let o = "";
  for (let k = 0; k < 4; k++) {
    const y = 214 + k * 5;
    o += `<line x1="${104 - k * 3}" y1="${y}" x2="${78 - k * 6}" y2="${y + 16}" stroke="#5a3a1c" stroke-width="2.2" stroke-linecap="round"/>`;
    o += `<line x1="${152 + k * 3}" y1="${y}" x2="${178 + k * 6}" y2="${y + 16}" stroke="#5a3a1c" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  o += `<path d="M98 212 Q128 206 158 212 L150 240 Q128 246 106 240 Z" fill="#6b4121" stroke="#3a220d" stroke-width="1.5"/>`;
  o += `<path d="M104 222 H152" stroke="#c9a15a" stroke-width="2"/>`;
  o += `<path d="M122 212 Q116 196 126 190 Q136 186 134 196 Q131 202 127 198" fill="none" stroke="#6b4121" stroke-width="4" stroke-linecap="round"/>`;
  o += `<line x1="128" y1="210" x2="128" y2="150" stroke="#4a2f17" stroke-width="3.2"/>`;
  o += `<line x1="100" y1="156" x2="156" y2="156" stroke="#4a2f17" stroke-width="2.4"/>`;
  o += `<path d="M102 157 H154 Q158 180 152 200 H104 Q98 180 102 157 Z" fill="#efe2c2" stroke="#8a7550" stroke-width="1"/>`;
  o += `<path d="M112 157 Q109 180 113 200 M144 157 Q147 180 143 200" stroke="#b32a24" stroke-width="6" fill="none"/>`;
  return o;
}

function cog() {
  // stern view: tall rounded hull, boxy aftcastle, single square sail with a red band
  let o = `<path d="M96 206 Q128 198 160 206 L154 242 Q128 250 102 242 Z" fill="#7a4a24" stroke="#3a220d" stroke-width="1.5"/>`;
  o += `<path d="M100 216 H156 M102 228 H154" stroke="#4e2e14" stroke-width="1.4"/>`;
  o += `<rect x="104" y="190" width="48" height="18" fill="#8a5a2e" stroke="#3a220d" stroke-width="1.5"/>`;
  o += `<path d="M104 190 H152" stroke="#c9a15a" stroke-width="2"/>`;
  o += `<rect x="124" y="196" width="8" height="8" fill="#2a1a0a"/>`;
  o += `<line x1="128" y1="190" x2="128" y2="136" stroke="#4a2f17" stroke-width="3.4"/>`;
  o += `<line x1="98" y1="143" x2="158" y2="143" stroke="#4a2f17" stroke-width="2.6"/>`;
  o += `<path d="M100 144 H156 Q161 166 154 186 H102 Q95 166 100 144 Z" fill="#f1e6cc" stroke="#8a7550" stroke-width="1"/>`;
  o += `<path d="M99 160 H157" stroke="#b32a24" stroke-width="7"/>`;
  o += `<path d="M128 136 l12 3 -12 3 Z" fill="#b32a24"/>`;
  return o;
}

function steamer() {
  // stern view: black hull with a red boot line, white deckhouse, red funnel with a black top, smoke
  let o = `<path d="M150 118 Q170 104 162 90 Q176 84 170 70" fill="none" stroke="#d8d6e8" stroke-width="9" stroke-linecap="round" opacity="0.45"/>`;
  o += `<path d="M92 214 H164 L158 244 Q128 250 98 244 Z" fill="#23242a" stroke="#101014" stroke-width="1.5"/>`;
  o += `<path d="M97 238 Q128 244 159 238" stroke="#b32a24" stroke-width="4" fill="none"/>`;
  o += `<rect x="102" y="192" width="52" height="22" fill="#eceae2" stroke="#8d8b83" stroke-width="1.2"/>`;
  for (let k = 0; k < 5; k++) o += `<rect x="${107 + k * 9.5}" y="199" width="5" height="5" fill="#3c4a63"/>`;
  o += `<rect x="112" y="178" width="32" height="14" fill="#e2e0d6" stroke="#8d8b83" stroke-width="1.2"/>`;
  o += `<path d="M120 178 L122 140 H136 L138 178 Z" fill="#c0342b" stroke="#6e1a14" stroke-width="1.2"/>`;
  o += `<rect x="121.6" y="140" width="14.8" height="8" fill="#1d1d22"/>`;
  o += `<path d="M130 138 Q134 124 146 120" fill="none" stroke="#d8d6e8" stroke-width="7" stroke-linecap="round" opacity="0.6"/>`;
  o += `<line x1="100" y1="214" x2="156" y2="214" stroke="#c9c9c2" stroke-width="1.6"/>`;
  return o;
}

/** A pair of lock gates standing open against the walls at depth s. */
function gates(age, s) {
  const [lx, ly] = water(-1, s), [rx, ry] = water(1, s);
  const h = wallH(age) * s * 1.02, leaf = (rx - lx) * 0.3;
  const col = age === "modern" ? ["#5d6670", "#2e343a"] : ["#6e4a26", "#3a220d"];
  const leafPts = (x, y, dir) => [[x, y + 2], [x + dir * leaf, y - 3], [x + dir * leaf, y - 3 - h], [x, y - h]];
  let o = "";
  for (const [x, y, dir] of [[lx, ly, 1], [rx, ry, -1]]) {
    o += `<polygon points="${pts(leafPts(x, y, dir))}" fill="${col[0]}" stroke="${col[1]}" stroke-width="1.2"/>`;
    for (const k of age === "modern" ? [0.33, 0.66] : [0.25, 0.5, 0.75]) {
      o += `<line x1="${f(x)}" y1="${f(y - h * k)}" x2="${f(x + dir * leaf)}" y2="${f(y - 3 - h * k)}" stroke="${col[1]}" stroke-width="1"/>`;
    }
    // balance beam over the bank
    o += `<line x1="${f(x)}" y1="${f(y - h)}" x2="${f(x - dir * leaf * 1.2)}" y2="${f(y - h - 2)}" stroke="${col[1]}" stroke-width="${f(2 + 2 * s)}" stroke-linecap="round"/>`;
  }
  return o;
}

function tower(x, y, sc) {
  const w = 16 * sc, h = 34 * sc;
  return `<rect x="${f(x - w / 2)}" y="${f(y - h)}" width="${f(w)}" height="${f(h)}" fill="#c4b89e" stroke="#6f6450" stroke-width="1"/>` +
    `<rect x="${f(x - w * 0.14)}" y="${f(y - h * 0.62)}" width="${f(w * 0.28)}" height="${f(h * 0.22)}" fill="#2a2320"/>` +
    `<polygon points="${pts([[x - w * 0.7, y - h], [x + w * 0.7, y - h], [x, y - h - 18 * sc]])}" fill="#a3322b" stroke="#5c1a15" stroke-width="1"/>`;
}

function lamp(x, y, h) {
  return `<line x1="${x}" y1="${y}" x2="${x}" y2="${y - h}" stroke="#2e343a" stroke-width="${f(h / 12)}"/>` +
    `<line x1="${x}" y1="${y - h}" x2="${f(x + h * 0.25)}" y2="${y - h}" stroke="#2e343a" stroke-width="${f(h / 14)}"/>` +
    `<circle cx="${f(x + h * 0.25)}" cy="${f(y - h + h * 0.06)}" r="${f(h * 0.07)}" fill="#fff0b0"/>`;
}

function crane(x, y, sc) {
  return `<g stroke="#b8862e" stroke-width="${f(2.4 * sc)}" fill="none" stroke-linecap="round">` +
    `<line x1="${x}" y1="${y}" x2="${x}" y2="${f(y - 48 * sc)}"/><line x1="${f(x - 8 * sc)}" y1="${f(y - 44 * sc)}" x2="${f(x + 34 * sc)}" y2="${f(y - 44 * sc)}"/>` +
    `<line x1="${x}" y1="${f(y - 48 * sc)}" x2="${f(x + 30 * sc)}" y2="${f(y - 44 * sc)}"/><line x1="${f(x + 30 * sc)}" y1="${f(y - 44 * sc)}" x2="${f(x + 30 * sc)}" y2="${f(y - 30 * sc)}" stroke-width="${f(1 * sc)}"/></g>`;
}

/** A ship drawn at the foreground scale, moved down the channel to depth s and shrunk to fit it there. */
function place(ship, s, k) {
  const [, y] = water(1, s);
  return `<g transform="translate(128 ${f(y)}) scale(${k}) translate(-128 -244)">${ship}</g>`;
}

function dressing(age) {
  if (age === "ancient") {
    const [lx, ly] = coping(age, -1, 0.9), [rx, ry] = coping(age, 1, 0.9);
    const [lx2, ly2] = coping(age, -1, 0.4), [rx2, ry2] = coping(age, 1, 0.4);
    return torch(lx2 - 5, ly2, 22) + torch(rx2 + 5, ry2, 22) + place(galley(), 0.72, 1.05) +
      torch(lx - 10, ly, 44) + torch(rx + 10, ry, 44);
  }
  if (age === "medieval") {
    const [tx, ty] = coping(age, 1, 0.26);
    return tower(tx + 16, ty + 2, 1) + place(cog(), 0.5, 0.78) + gates(age, 0.86);
  }
  const [cx, cy] = coping(age, -1, 0.3);
  const [l2x, l2y] = coping(age, 1, 0.95);
  return crane(cx - 24, cy + 2, 0.9) + place(steamer(), 0.5, 0.78) + gates(age, 0.86) + lamp(l2x + 12, l2y, 46);
}

/** Depth: banks and walls darken toward the horizon, and the disc darkens toward the rim as the game's icons do. */
function shading(id) {
  return `<rect y="${HZ - 6}" width="256" height="70" fill="url(#haze${id})"/>` +
    `<circle cx="${C}" cy="${C}" r="114" fill="url(#vig${id})"/>`;
}

function svg(age) {
  const id = age[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>${frameDefs(id)}</defs>
  <g clip-path="url(#disc${id})">
    <rect width="256" height="256" fill="url(#sky${id})"/>
    <g transform="translate(128 132) scale(1.14) translate(-128 -132)">
    <rect y="${HZ - 60}" width="256" height="60" fill="url(#glow${id})"/>
    ${landscape(age, id)}
    ${channel(age, id)}
    ${shading(id)}
    ${dressing(age)}
    </g>
  </g>${frame(id)}
</svg>
`;
}

mkdirSync(join(ROOT, "art"), { recursive: true });
mkdirSync(join(ROOT, "icons"), { recursive: true });
for (const age of ["ancient", "medieval", "modern"]) {
  const src = join(ROOT, "art", `canal-${age}.svg`);
  writeFileSync(src, svg(age));
  for (const size of SIZES) {
    const out = join(ROOT, "icons", `building_canal_${age}_${size}.png`);
    execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", out, src]);
  }
  console.log(`canal-${age}: ${SIZES.join(", ")} px`);
}
