// pedia-pages.test.mjs
//
// Civilopedia page-resolution gate: every page the mod adds must have text to draw.
//
// The pedia resolves a chaptered page's body without any database row: for each chapter of the page's layout it
// looks for that chapter's paragraphs by key convention and stops at the first gap (base-standard
// ui/civilopedia/model-civilopedia.js, getChapterBody → findChapterTextKey):
//
//     <prefix>_CHAPTER_<chapter>_BODY            one paragraph, or
//     <prefix>_CHAPTER_<chapter>_PARA_1, _PARA_2, …   until a number is missing
//
// where <prefix> is tried as LOC_PEDIA_<section>_PAGE_<page>, then LOC_PEDIA_<section>_PAGE, then
// LOC_PEDIA_PAGE_<page>, then LOC_PEDIA_PAGE. A chapter with no text is skipped silently and a page whose
// chapters are all empty renders as a title with nothing under it: no error, no log line, nothing to notice
// short of opening the page in game. The same is true of a mistyped page Name. So this gate walks the shipped
// data exactly as the engine does and fails on a page that would come up blank, a paragraph sequence with a hole
// in it (PARA_1 and PARA_3 silently drops PARA_3), a layout or page group that is referenced but never defined,
// and any referenced LOC key with no en_us row.
//
// It also checks the search terms (every Term key has text and names a real page) and that each page and group
// title fits the sidebar, which truncates long names with an ellipsis.
//
// It does not show that the engine draws them; only opening the Civilopedia in game does that. It covers the mod's
// side of the contract. Ported from Universal Auto Explore.
//
// Run as a plain node script (no engine loader needed): `node ./tests/pedia-pages.test.mjs` (also run by npm run verify).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SECTION_PREFIX = "LOC_PEDIA_";
const failures = [];
const fail = (msg) => failures.push(msg);

const read = (p) => fs.readFileSync(p, "utf8");
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
/** @param {string} tag @returns {Record<string,string>} The tag's attributes. */
function attrsOf(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}
/** Every `<Row …>` inside every `<table>…</table>` block of `xml`. */
function rowsIn(xml, table) {
  const out = [];
  for (const block of xml.matchAll(new RegExp(`<${table}(?:\\s[^>]*)?>([\\s\\S]*?)</${table}>`, "g"))) {
    for (const m of block[1].matchAll(/<Row(\s[^>]*?)\/?>/g)) out.push(attrsOf(m[1]));
  }
  return out;
}

// what the mod ships
const dataFiles = walk("data").filter((f) => f.endsWith(".xml") && /Civilopedia/.test(read(f)));
assert.ok(dataFiles.length, "no Civilopedia data file found under data/");
const dataXml = dataFiles.map(read).join("\n");

// Every LOC key with an en_us row, from text/en_us.
const defined = new Set();
for (const f of walk("text/en_us").filter((p) => p.endsWith(".xml"))) {
  for (const m of read(f).matchAll(/<(?:Row|Replace)\s+Tag="([A-Z0-9_]+)"/g)) defined.add(m[1]);
}

const sections = rowsIn(dataXml, "CivilopediaSections");
const groups = rowsIn(dataXml, "CivilopediaPageGroups");
const layouts = rowsIn(dataXml, "CivilopediaPageLayouts");
const layoutChapters = rowsIn(dataXml, "CivilopediaPageLayoutChapters");
const pages = rowsIn(dataXml, "CivilopediaPages");
const paragraphRows = rowsIn(dataXml, "CivilopediaPageChapterParagraphs");
const searchTerms = rowsIn(dataXml, "CivilopediaPageSearchTerms");

// Base-game sections the mod adds a page group to without defining them (the Canals group sits in Game Concepts).
const BASE_SECTIONS = ["CONCEPTS"];
const BASE_GROUPS = [];
// Longest sidebar name that draws without an ellipsis ("Notifications & the City R..." was cut at 26).
const MAX_TAB_CHARS = 24;

// Base-game layouts the mod reuses rather than defines. "Concept" is a single CONTENT chapter
// (base-standard/data/civilopedia.xml), so a page on it needs an explicit paragraph row.
const BASE_LAYOUTS = { Concept: ["CONTENT"] };

/** chapters of a layout, ours or the base game's. */
const chaptersOf = (layoutId) => {
  if (BASE_LAYOUTS[layoutId]) return BASE_LAYOUTS[layoutId];
  return layoutChapters.filter((r) => r.PageLayoutID === layoutId).map((r) => r.ChapterID);
};

/** The explicit paragraph row for a page's chapter, if it has one. */
const paragraphFor = (page, chapter) =>
  paragraphRows.find((r) => r.SectionID === page.SectionID && r.PageID === page.PageID && r.ChapterID === chapter);

/**
 * The paragraph keys the engine would find for one chapter, by the convention above, tried against each key
 * prefix in the engine's order. An empty array means the chapter draws nothing.
 */
function conventionParagraphs(page, chapter) {
  const prefixes = [
    `${SECTION_PREFIX}${page.SectionID}_PAGE_${page.PageID}`,
    `${SECTION_PREFIX}${page.SectionID}_PAGE`,
    `${SECTION_PREFIX}PAGE_${page.PageID}`,
    `${SECTION_PREFIX}PAGE`
  ];
  for (const prefix of prefixes) {
    const stem = `${prefix}_CHAPTER_${chapter}`;
    if (defined.has(`${stem}_BODY`)) return [`${stem}_BODY`];
    const found = [];
    for (let i = 1; defined.has(`${stem}_PARA_${i}`); i++) found.push(`${stem}_PARA_${i}`);
    // A hole in the sequence is silent data loss: the engine stops at the gap and never reads past it. This has
    // to run even when nothing was found, because the commonest way to make the hole is to lose PARA_1 itself,
    // which strands the whole chapter while leaving its text in the file.
    const stranded = [];
    for (let i = found.length + 2; i <= found.length + 20; i++) if (defined.has(`${stem}_PARA_${i}`)) stranded.push(i);
    if (stranded.length) {
      fail(`${page.PageID}/${chapter}: ${stem}_PARA_${found.length + 1} is missing, so the engine stops there and never draws ${stranded.map((i) => "PARA_" + i).join(", ")}`);
    }
    if (found.length) return found;
  }
  return [];
}

// 0) foreign-key ordering within each file
// CivilopediaPages.PageLayoutID and CivilopediaPageLayoutChapters.PageLayoutID are real foreign keys onto
// CivilopediaPageLayouts (01_GameplaySchema.sql), and the loader inserts in document order, so a file that
// references one of its own layouts before declaring it inserts against a row that does not exist yet. That is
// the load-time crash class this package guards against, and it is invisible until a game tries to start.
const blockStart = (xml, table) => xml.indexOf(`<${table}>`);
for (const f of dataFiles) {
  const xml = read(f);
  const declared = new Set(rowsIn(xml, "CivilopediaPageLayouts").map((r) => r.PageLayoutID));
  const layoutsAt = blockStart(xml, "CivilopediaPageLayouts");
  for (const table of ["CivilopediaPages", "CivilopediaPageLayoutChapters"]) {
    const usesOwn = rowsIn(xml, table).some((r) => declared.has(r.PageLayoutID));
    const at = blockStart(xml, table);
    if (usesOwn && at !== -1 && (layoutsAt === -1 || layoutsAt > at)) {
      fail(`${f}: <${table}> references a layout this file declares, but <CivilopediaPageLayouts> comes after it; the foreign key would be inserted against a missing row`);
    }
  }
}

// 1) sections, groups and layouts are defined where they are referenced
const sectionIds = new Set([...sections.map((r) => r.SectionID), ...BASE_SECTIONS]);
const groupIds = new Set([...groups.map((r) => `${r.SectionID}|${r.PageGroupID}`), ...BASE_GROUPS]);
const layoutIds = new Set([...layouts.map((r) => r.PageLayoutID), ...Object.keys(BASE_LAYOUTS)]);

for (const r of sections) if (!defined.has(r.Name)) fail(`section ${r.SectionID}: Name ${r.Name} has no en_us row`);
for (const r of groups) {
  if (!sectionIds.has(r.SectionID)) fail(`page group ${r.PageGroupID}: unknown SectionID ${r.SectionID}`);
  if (!defined.has(r.Name)) fail(`page group ${r.PageGroupID}: Name ${r.Name} has no en_us row`);
}
for (const r of layoutChapters) {
  if (!layouts.some((l) => l.PageLayoutID === r.PageLayoutID)) fail(`layout chapter ${r.PageLayoutID}/${r.ChapterID}: layout ${r.PageLayoutID} is not defined by this mod`);
}

// 2) every page resolves to a title and to at least one chapter with text
assert.ok(pages.length, "no CivilopediaPages rows");
let chaptersWithText = 0;
let paragraphsTotal = 0;
for (const page of pages) {
  const id = `${page.SectionID}/${page.PageID}`;
  if (!sectionIds.has(page.SectionID)) fail(`${id}: unknown SectionID`);
  if (!groupIds.has(`${page.SectionID}|${page.PageGroupID}`)) fail(`${id}: PageGroupID ${page.PageGroupID} is not defined`);
  if (!layoutIds.has(page.PageLayoutID)) fail(`${id}: PageLayoutID ${page.PageLayoutID} is not defined`);
  if (!defined.has(page.Name)) fail(`${id}: Name ${page.Name} has no en_us row`);

  const chapters = chaptersOf(page.PageLayoutID);
  if (!chapters.length) {
    fail(`${id}: layout ${page.PageLayoutID} declares no chapters, so the page can never draw a body`);
    continue;
  }
  let withText = 0;
  for (const chapter of chapters) {
    const explicit = paragraphFor(page, chapter);
    if (explicit) {
      if (!defined.has(explicit.Paragraph)) fail(`${id}/${chapter}: Paragraph ${explicit.Paragraph} has no en_us row`);
      withText++;
      paragraphsTotal++;
      continue;
    }
    const found = conventionParagraphs(page, chapter);
    if (found.length) {
      withText++;
      paragraphsTotal += found.length;
    }
  }
  if (!withText) fail(`${id}: no chapter has any text, so the page renders as a bare title`);
  chaptersWithText += withText;
}

// 2b) sidebar names fit, page ids are unique
// The pedia's search (the box, and engine.trigger("open-civilopedia", id)) matches a bare page id across every
// section, so two pages sharing an id make one of them unreachable by id.
const textOf = (key) => {
  for (const f of walk("text/en_us").filter((p) => p.endsWith(".xml"))) {
    const m = read(f).match(new RegExp(`<Row\\s+Tag="${key}"\\s*>\\s*<Text>([\\s\\S]*?)</Text>`));
    if (m) return m[1].replace(/&amp;/g, "&");
  }
  return null;
};
for (const r of [...pages, ...groups]) {
  const t = textOf(r.Name);
  if (t && t.length > MAX_TAB_CHARS) fail(`${r.PageID ?? r.PageGroupID}: sidebar name "${t}" is ${t.length} characters; the sidebar truncates past ${MAX_TAB_CHARS}`);
}
const seenIds = new Set();
for (const p of pages) {
  if (seenIds.has(p.PageID)) fail(`page id ${p.PageID} is used twice`);
  seenIds.add(p.PageID);
}

// 2c) search terms name real pages and have text
for (const r of searchTerms) {
  if (!pages.some((p) => p.SectionID === r.SectionID && p.PageID === r.PageID)) fail(`search term ${r.Term}: no page ${r.SectionID}/${r.PageID}`);
  if (!defined.has(r.Term)) fail(`search term ${r.Term} has no en_us row`);
}

// 3) no orphaned paragraph rows
for (const r of paragraphRows) {
  const page = pages.find((p) => p.SectionID === r.SectionID && p.PageID === r.PageID);
  if (!page) {
    fail(`paragraph row ${r.SectionID}/${r.PageID}/${r.ChapterID}: no such page`);
    continue;
  }
  if (!chaptersOf(page.PageLayoutID).includes(r.ChapterID)) {
    fail(`paragraph row ${r.SectionID}/${r.PageID}/${r.ChapterID}: layout ${page.PageLayoutID} has no such chapter, so the text is never drawn`);
  }
}

// 4) a chapter title row that names a chapter no layout has is dead text
// (Cheap catch for a renamed chapter: the title stays behind and nothing shows it.)
const chapterIds = new Set(layoutChapters.map((r) => r.ChapterID));
for (const key of defined) {
  const m = key.match(/^LOC_PEDIA_[A-Z0-9]+_PAGE(?:_[A-Z0-9_]+?)?_CHAPTER_([A-Z0-9]+)_TITLE$/);
  if (m && !chapterIds.has(m[1]) && !Object.values(BASE_LAYOUTS).some((c) => c.includes(m[1]))) {
    fail(`${key}: no layout declares a chapter named ${m[1]}, so this title is never drawn`);
  }
}

if (failures.length) {
  console.error(`\npedia-pages FAILED, ${failures.length} problem(s):`);
  for (const f of failures) console.error("   - " + f);
  process.exit(1);
}
console.log(`pedia-pages harness passed (${pages.length} pages, ${searchTerms.length} search terms, ${chaptersWithText} chapters with text, ${paragraphsTotal} paragraphs, across ${dataFiles.length} data file(s))`);
