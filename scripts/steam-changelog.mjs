#!/usr/bin/env node
// steam-changelog.mjs: keep CHANGELOG.steam.txt (Steam Workshop change notes) in step with CHANGELOG.md.
//
// The same file is copied into every tower mod; keep the copies identical.
//
//   node scripts/steam-changelog.mjs sync            write/refresh CHANGELOG.steam.txt
//   node scripts/steam-changelog.mjs note <version>  sync, then print that release's note for the .vdf
//
// Why a separate file: CHANGELOG.md is markdown for GitHub; Steam change notes are BBCode with their own rendering
// rules. The Steam file holds one ready-to-paste block per release, so release.sh can upload the current one and old
// Workshop entries can be fixed by pasting their block into the Steam "Edit" box.
//
// Steam rendering rules (seen on the live change-notes page, 2026-09-21):
//   - The whole note sits in one <p>, and every newline becomes a <br>.
//   - [list] must not be used: a <ul> cannot nest in a <p>, so the note's box closes at the first list and the
//     bullets spill out below it. Bullets are plain "• " lines instead.
//   - [b], [i] and [url] render.
//   - steamcmd's VDF parser ends the string at an escaped \" (it truncated earlier notes mid-sentence), so the note
//     carries no straight double quotes and no backslashes.
//
// Hand edits: each block header records a hash of its CHANGELOG.md section (src) and of the generated text (gen).
// A block whose text no longer matches gen was edited by hand and is never overwritten. If its CHANGELOG.md section
// changes afterwards, `note` for that version stops with an error so the two can be reconciled (delete the block to
// regenerate it).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MD_FILE = 'CHANGELOG.md';
const STEAM_FILE = 'CHANGELOG.steam.txt';
// Longest note sent in full. Past it the note keeps only each bullet's headline and links the full changelog.
const NOTE_BUDGET = 5000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const EM_SPACE = '\u2003';

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pb = b.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ── CHANGELOG.md → sections ────────────────────────────────────────────────────────────────────────────────────────

function parseMarkdown(md) {
  const sections = [];
  let cur = null;
  for (const line of md.split('\n')) {
    const h = /^## \[([^\]]+)\](?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (h) {
      cur = /^unreleased$/i.test(h[1]) ? null : { version: h[1], date: h[2] || '', lines: [] };
      if (cur) sections.push(cur);
      continue;
    }
    if (/^## /.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  for (const s of sections) {
    while (s.lines.length && !s.lines.at(-1).trim()) s.lines.pop();
    s.raw = s.lines.join('\n');
  }
  return sections;
}

// Group a section's lines into blocks: { kind: 'para' | 'heading' | 'item' | 'subitem', text }.
function blocksOf(lines) {
  const blocks = [];
  let cur = null;
  const push = (kind, text) => { cur = { kind, text }; blocks.push(cur); };
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]:\s/.test(line) || /^\s*<!--.*-->\s*$/.test(line)) continue;
    if (!line.trim()) { cur = null; continue; }
    const heading = /^#{3,6}\s+(.*)$/.exec(line);
    const item = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
    const sub = /^\s{2,}([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (heading) { push('heading', heading[1].trim()); cur = null; }
    else if (item) push('item', item[2].trim());
    else if (sub) push('subitem', sub[2].trim());
    else if (cur) cur.text += ` ${line.trim()}`;
    else push('para', line.trim());
  }
  return blocks;
}

// Inline markdown → Steam BBCode, made VDF-safe.
function inline(text) {
  return text
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '[url=$2]$1[/url]')
    .replace(/\*\*([^*]+)\*\*/g, '[b]$1[/b]')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1[i]$2[/i]')
    .replace(/`/g, '')
    .replace(/\\/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/"([^"]*)"/g, '\u201C$1\u201D')
    .replace(/"/g, '\u201D')
    .replace(/\s+$/, '');
}

// A bullet's headline: its leading bold phrase, else its first sentence.
function headline(text) {
  const bold = /^\*\*([^*]+)\*\*/.exec(text);
  if (bold) return bold[1].replace(/[.:]\s*$/, '');
  const first = text.split(/(?<=[.!?])\s/)[0];
  return first.length > 140 ? `${first.slice(0, 137).trimEnd()}...` : first.replace(/[.:]\s*$/, '');
}

function render(section, changelogUrl) {
  const date = humanDate(section.date);
  const title = `[b]Version ${section.version}${date ? ` · ${date}` : ''}[/b]`;
  const blocks = blocksOf(section.lines);

  const build = (compact, keepItems = Infinity) => {
    const out = [title];
    let items = 0;
    let dropped = false;
    for (const b of blocks) {
      if (b.kind === 'heading') { out.push('', `[b]${inline(b.text)}[/b]`); continue; }
      if (b.kind === 'para') { if (!compact || !items) out.push(inline(b.text)); continue; }
      if (compact && b.kind === 'subitem') continue;
      if (b.kind === 'item' && ++items > keepItems) { dropped = true; continue; }
      if (items > keepItems) continue;
      if (b.kind === 'subitem') out.push(`${EM_SPACE}◦ ${inline(b.text)}`);
      else out.push(`• ${compact ? inline(headline(b.text)) : inline(b.text)}`);
    }
    if (compact && changelogUrl) {
      out.push('', `${dropped ? 'More changes' : 'Details'} in the [url=${changelogUrl}]full changelog[/url].`);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  };

  let note = build(false);
  if (note.length <= NOTE_BUDGET) return note;
  note = build(true);
  for (let keep = blocks.filter((b) => b.kind === 'item').length; note.length > NOTE_BUDGET && keep > 0; keep--) {
    note = build(true, keep);
  }
  return note;
}

function changelogUrl() {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    return m ? `https://github.com/${m[1]}/${m[2]}/blob/main/${MD_FILE}` : '';
  } catch {
    return '';
  }
}

// ── CHANGELOG.steam.txt ────────────────────────────────────────────────────────────────────────────────────────────

const HEADER_RE = /^==== (\S+) \| ([^|]*) \| src (\w+) \| gen (\w+) ====$/;

const PREAMBLE = `Steam Workshop change notes, one block per release, newest first.
Generated from CHANGELOG.md by scripts/steam-changelog.mjs; release.sh uploads the block for the version it builds.
To fix an old Workshop entry, paste the text under its ==== line into that entry's Edit box on the change-notes page.
A block edited by hand is kept as-is. Delete a block to regenerate it from CHANGELOG.md.
`;

function parseSteam(text) {
  const blocks = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    const h = HEADER_RE.exec(line);
    if (h) {
      cur = { version: h[1], date: h[2].trim(), src: h[3], gen: h[4], lines: [] };
      blocks.set(cur.version, cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  for (const b of blocks.values()) {
    while (b.lines.length && !b.lines.at(-1).trim()) b.lines.pop();
    b.text = b.lines.join('\n');
  }
  return blocks;
}

function sync() {
  if (!existsSync(MD_FILE)) throw new Error(`${MD_FILE} not found in ${process.cwd()}`);
  const sections = parseMarkdown(readFileSync(MD_FILE, 'utf8'));
  const existing = existsSync(STEAM_FILE) ? parseSteam(readFileSync(STEAM_FILE, 'utf8')) : new Map();
  const url = changelogUrl();
  const conflicts = new Set();
  const merged = new Map(existing);

  for (const s of sections) {
    const text = render(s, url);
    const fresh = { version: s.version, date: s.date, src: hash(s.raw), gen: hash(text), text };
    const old = existing.get(s.version);
    if (!old) { merged.set(s.version, fresh); continue; }
    const handEdited = hash(old.text) !== old.gen;
    if (!handEdited) merged.set(s.version, fresh);
    else if (old.src !== fresh.src) conflicts.add(s.version);
  }

  const ordered = [...merged.values()].sort((a, b) => compareVersions(b.version, a.version));
  const body = ordered.map((b) => `==== ${b.version} | ${b.date} | src ${b.src} | gen ${b.gen} ====\n${b.text}\n`);
  const out = `${PREAMBLE}\n${body.join('\n')}`;
  if (!existsSync(STEAM_FILE) || readFileSync(STEAM_FILE, 'utf8') !== out) writeFileSync(STEAM_FILE, out);
  for (const v of conflicts) {
    console.error(`steam-changelog: ${v} was edited by hand in ${STEAM_FILE} and its ${MD_FILE} section has changed `
      + 'since; kept the hand-edited text. Update it, or delete the block to regenerate.');
  }
  return { blocks: merged, conflicts };
}

function main() {
  const [cmd, version] = process.argv.slice(2);
  if (cmd === 'sync') { sync(); return; }
  if (cmd === 'note' && version) {
    const { blocks, conflicts } = sync();
    const block = blocks.get(version);
    if (!block) throw new Error(`no ## [${version}] section in ${MD_FILE}`);
    if (conflicts.has(version)) throw new Error(`reconcile ${version} in ${STEAM_FILE} before releasing`);
    if (/["\\]/.test(block.text)) throw new Error(`${version} note contains a straight quote or backslash`);
    process.stdout.write(block.text);
    return;
  }
  console.error('usage: steam-changelog.mjs sync | note <version>');
  process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(`steam-changelog: ${err.message}`);
  process.exit(1);
}
