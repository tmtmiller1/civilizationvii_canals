// settings-keeper.js - Tower Settings Keeper: a working localStorage on top of the one row the game can read.
//
// Civilization VII's localStorage.getItem() ignores its key and returns the first row of the store in key order.
// key(i) is always null. Writes, removeItem(), clear() and length are correct. A mod can therefore read back what it
// stored only if its key happens to sort first, and the usual read-modify-write of a mod's own key copies the first
// row's data over it. That is why mod settings vanish between launches.
//
// The keeper owns exactly one real row, "modSettings", and runs every localStorage call through it.
//   - getItem, setItem and removeItem on any other key read and write root.__ls[key] inside that row.
//   - "modSettings" itself is passed through without the keeper's own fields. Mods that keep a section per mod id
//     in it work unchanged, and their write-back keeps every other key intact.
//   - length reports 1, so the "clear() when length > 1" guard many mods carry never runs. key(i) stays null as the
//     engine has it, so a loop that lists keys in order to remove them stays the no-op it has always been.
//   - clear() empties the store and writes the root back with the other mods' keys kept.
//   - A write that would take the row past LIMIT_BYTES is refused with the QuotaExceededError browsers throw, the
//     earlier value is kept, and the mod responsible is named in the log and in the keeper's mark. The game process
//     stopped in testing once the row passed about 14 MB; the limit sits well below that.
// At start-up the keeper makes sure its root is row 1. Rows that sort before it and can be identified by content (see
// KNOWN_KEYS below) are removed and folded into the root. Their bytes move; nothing is lost. A row it cannot identify
// is never touched. If that row is the only one left, the store is rebuilt around it. Otherwise the keeper writes its
// root under "\u0001", the lowest key the engine stores, copies any mod sections the row holds, and keeps the row's
// full text in the root for recovery. Reads work from then on.
//
// This is one file on purpose. A script with no imports runs as early as the loader runs any script, and the keeper
// needs to run first. install() is pure and exported for the tests. The self-install at the end runs only where the
// engine's localStorage exists. install() patches the object it is given, so a mod that captured a reference to
// localStorage before this ran still goes through the keeper.

export const ROOT_KEY = "modSettings";
export const FALLBACK_ROOT_KEY = "\u0001";
export const VIRTUAL_KEY = "__ls";
export const MARK_KEY = "__settings-keeper";
export const BLOCKED_KEY = "__blocked";
export const VERSION = 1; // layout of the keeper's mark
export const BUILD = 112; // this file's build; a newer copy replaces an older installed one
export const LIMIT_BYTES = 4 * 1024 * 1024; // the whole row; see docs/design.md, Load and limits
const INTERNAL = [VIRTUAL_KEY, MARK_KEY, BLOCKED_KEY];
const MAX_FOLD_STEPS = 32;
const BLOCKED_COPY_LIMIT = 2 * 1024 * 1024;

/** @returns {boolean} Whether v is a plain object (not null, not an array). */
export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** @returns {boolean} A settings root: a plain object whose top-level values are all objects, one section per mod. */
export function looksLikeRoot(o) {
  if (!isPlainObject(o)) return false;
  if (o[MARK_KEY]) return true;
  return Object.keys(o).every((k) => isPlainObject(o[k]));
}

function parse(text) {
  if (typeof text !== "string" || !text.length) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function safeMatch(entry, obj, text) {
  try {
    return typeof entry.match === "function" && entry.match(obj, text) === true;
  } catch (_) {
    return false;
  }
}

/** The error browsers throw when localStorage is full. Mods written against the web API know it by name. */
function quotaError(message) {
  try {
    const DE = typeof globalThis !== "undefined" ? globalThis.DOMException : undefined;
    if (typeof DE === "function") return new DE(message, "QuotaExceededError");
  } catch (_) {
    /* no DOMException in this runtime */
  }
  const e = new Error(message);
  e.name = "QuotaExceededError";
  e.code = 22;
  return e;
}

function jsonLength(v) {
  if (v === undefined) return 0;
  try {
    return JSON.stringify(v).length;
  } catch (_) {
    return 0;
  }
}

function withoutInternals(o) {
  const out = {};
  for (const k of Object.keys(o)) if (!INTERNAL.includes(k)) out[k] = o[k];
  return out;
}

/**
 * The engine's own methods, captured before anything is patched. In the game the methods live on Storage.prototype
 * and length is a prototype getter. In the tests they live on the object itself.
 */
function captureEngine(ls) {
  const proto = Object.getPrototypeOf(ls) || {};
  const pick = (n) => (typeof proto[n] === "function" ? proto[n] : ls[n]);
  const fn = { getItem: pick("getItem"), setItem: pick("setItem"), removeItem: pick("removeItem"), clear: pick("clear") };
  for (const n of Object.keys(fn)) if (typeof fn[n] !== "function") throw new Error("localStorage has no " + n);
  const lenDesc = Object.getOwnPropertyDescriptor(proto, "length");
  const lenGet = lenDesc && typeof lenDesc.get === "function" ? lenDesc.get : null;
  return {
    get: (k) => fn.getItem.call(ls, k),
    set: (k, v) => fn.setItem.call(ls, k, v),
    remove: (k) => fn.removeItem.call(ls, k),
    clear: () => fn.clear.call(ls),
    length: () => (lenGet ? lenGet.call(ls) : ls.length),
    canShadowLength: !!lenGet
  };
}

class Keeper {
  constructor(ls, opts) {
    this.ls = ls;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.known = Array.isArray(opts.knownKeys) ? opts.knownKeys : [];
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.origin = typeof opts.origin === "string" ? opts.origin : "";
    this.limit = typeof opts.limitBytes === "number" && opts.limitBytes > 0 ? opts.limitBytes : LIMIT_BYTES;
    this.estBytes = 0; // the row's size: exact after every read or flush, adjusted per write in between
    this.engine = captureEngine(ls);
    this.rootKey = ROOT_KEY;
    this.cacheText = null;
    this.cacheRoot = null;
    this.cachePublic = null;
    this.foreign = false;
    this.blocked = false;
    this.folded = [];
    this.sync = true; // start-up writes go straight to the engine; after patch() they are coalesced per task
    this.pending = null;
  }

  // ---- the real row ---------------------------------------------------------------------------------------------

  /**
   * Row 1 as the keeper's root, parsed and cached by text. The root always carries the keeper's mark. A row 1
   * without it is another mod's row, written raw since start-up. The keeper then reads null and refuses writes
   * rather than copy that row over the root. The next launch's start-up scan deals with it.
   */
  readRoot() {
    if (this.pending) return this.pending;
    let text = null;
    try {
      text = this.engine.get(this.rootKey);
      if (!text) text = this.engine.get(this.rootKey);
    } catch (e) {
      this.log("error", "read failed: " + e);
      this.foreign = true;
      return null;
    }
    if (!text) return this.setCache(null, {});
    if (text === this.cacheText) return this.cacheRoot;
    const obj = parse(text);
    if (isPlainObject(obj) && isPlainObject(obj[MARK_KEY])) return this.setCache(text, obj);
    if (!this.foreign) this.log("error", "row 1 is not the keeper's root; reads empty and writes refused until the next launch");
    this.foreign = true;
    return null;
  }

  setCache(text, root) {
    this.cacheText = text;
    this.cacheRoot = root;
    this.cachePublic = null;
    this.foreign = false;
    this.estBytes = typeof text === "string" ? text.length : 0;
    return root;
  }

  // ---- the size limit ---------------------------------------------------------------------------------------------

  /**
   * Refuse a write that would take the row past the limit. Throws the quota error after noting who asked, so the
   * Options row can name the mod. `culprit` is computed only when the write is refused.
   */
  guard(root, key, delta, culprit) {
    const projected = this.estBytes + delta;
    if (projected <= this.limit) return;
    const by = culprit ? culprit() : key;
    const mark = isPlainObject(root[MARK_KEY]) ? root[MARK_KEY] : (root[MARK_KEY] = {});
    mark.refused = { by, key, bytes: projected, limit: this.limit, at: this.now() };
    this.writeRoot(root);
    const msg = "write of " + JSON.stringify(key) + " by " + JSON.stringify(by) + " refused: the store would be " +
      projected + " bytes, over the " + this.limit + " byte limit; the earlier value is kept";
    this.log("error", msg);
    throw quotaError("[settings-keeper] " + msg);
  }

  /** A write for the refused own key that fits ends the notice. null clears any notice. */
  clearRefusal(root, key) {
    const mark = root[MARK_KEY];
    if (!isPlainObject(mark) || !isPlainObject(mark.refused)) return;
    if (key === null || mark.refused.key === key) delete mark.refused;
  }

  refusal(root) {
    const mark = root ? root[MARK_KEY] : null;
    return isPlainObject(mark) && isPlainObject(mark.refused) ? mark.refused : null;
  }

  dismissRefusal() {
    const root = this.readRoot();
    if (!root) return;
    this.clearRefusal(root, null);
    this.writeRoot(root);
  }

  /** The section of a modSettings write that grew the most, or the largest one when none grew. */
  culpritSection(next, root) {
    let best = ROOT_KEY;
    let bestGrowth = -Infinity;
    let largest = 0;
    for (const k of Object.keys(next)) {
      const size = jsonLength(next[k]);
      const growth = size - jsonLength(root[k]);
      if (growth > bestGrowth) {
        bestGrowth = growth;
        best = k;
      }
      if (growth <= 0 && size > largest && bestGrowth <= 0) {
        largest = size;
        best = k;
      }
    }
    return best;
  }

  /** The public part of the root as JSON, or null when there are no sections. Cached until the row changes. */
  publicText(root) {
    if (this.cachePublic === null) {
      const view = withoutInternals(root);
      this.cachePublic = Object.keys(view).length ? JSON.stringify(view) : "";
    }
    return this.cachePublic || null;
  }

  /**
   * Serialising a root of several hundred KB costs milliseconds. After start-up a write therefore only updates the
   * root in memory and queues one engine write for the end of the current task. A burst of writes, such as a chunked
   * backup, costs one serialisation, and reads in between see the new values. Nothing else can run before the queued
   * write lands.
   */
  writeRoot(root) {
    if (!isPlainObject(root[MARK_KEY])) root[MARK_KEY] = { v: VERSION, root: this.rootKey, since: this.now() };
    else root[MARK_KEY].root = this.rootKey;
    if (this.sync) return this.flushRoot(root);
    const queued = !!this.pending;
    this.pending = root;
    this.cachePublic = null;
    if (!queued) Promise.resolve().then(() => this.flush());
  }

  flush() {
    const root = this.pending;
    if (!root) return;
    this.pending = null;
    this.flushRoot(root);
  }

  flushRoot(root) {
    const text = JSON.stringify(root);
    this.engine.set(this.rootKey, text);
    this.setCache(text, root);
  }

  /** Whether row 1, whose text is given, is stored under `key`: rewriting it with its own text leaves length as is. */
  probeIs(key, text) {
    const before = this.engine.length();
    this.engine.set(key, text);
    if (this.engine.length() === before) return true;
    this.engine.remove(key);
    return false;
  }

  // ---- start-up: make the root row 1 --------------------------------------------------------------------------

  identify(obj, text) {
    for (const k of this.known) if (safeMatch(k, obj, text) && this.probeIs(k.key, text)) return k.key;
    return null;
  }

  finishFold() {
    if (!this.folded.length) return;
    const root = this.readRoot() || {};
    const virt = isPlainObject(root[VIRTUAL_KEY]) ? root[VIRTUAL_KEY] : {};
    for (const [k, v] of this.folded) virt[k] = v;
    root[VIRTUAL_KEY] = virt;
    this.writeRoot(root);
    this.log("warn", "folded " + this.folded.map(([k]) => k).join(", ") + " into the root");
  }

  /** Row 1 cannot be identified. Write the root under the lowest key and copy what the row holds. Never touch it. */
  blockedMode(text) {
    this.blocked = true;
    this.rootKey = FALLBACK_ROOT_KEY;
    const root = this.rootFromUnnamed(text);
    this.writeRoot(root);
    const copied = Object.keys(root).length - 2;
    this.log("error", "row 1 (" + text.length + " bytes) could not be named and " + (this.engine.length() - 1) +
      " more rows hide behind it; root written under the lowest key, " + copied + " slices copied, the row kept as a copy");
  }

  /** One fold step. True when the root is row 1, false when stopped in fallback mode, null to go on. */
  foldStep() {
    const text = this.engine.get(ROOT_KEY);
    if (text == null) return true;
    const obj = parse(text);
    if (this.adoptMarked(obj, text)) return true;
    const k = this.identify(obj, text);
    if (k) {
      this.folded.push([k, text]);
      this.engine.remove(k);
      this.log("warn", "moved row " + JSON.stringify(k) + " (" + text.length + " bytes) out of the way");
      return null;
    }
    // an unmarked settings root is probed only when nothing can be hidden behind it
    if (looksLikeRoot(obj) && this.engine.length() === 1 && this.probeIs(ROOT_KEY, text)) return this.adopt(ROOT_KEY);
    // a lone row that cannot be identified has nothing behind it, and its text is in memory, so the store can be
    // rebuilt around it
    if (this.engine.length() === 1) {
      this.collapseLoneRow(text);
      return true;
    }
    this.blockedMode(text);
    return false;
  }

  /** The only row left cannot be identified. Keep its sections and its text in a normal root and drop the row. */
  collapseLoneRow(text) {
    this.engine.clear();
    this.rootKey = ROOT_KEY;
    this.blocked = false;
    this.writeRoot(this.rootFromUnnamed(text));
    this.log("warn", "the one row left (" + text.length + " bytes) could not be named; its slices and text were kept " +
      "and the store rebuilt as modSettings");
  }

  /** A root built from an unidentified row: its object-valued entries as sections, its text under __blocked. */
  rootFromUnnamed(text) {
    const obj = parse(text);
    const root = isPlainObject(obj) ? withoutInternals(obj) : {};
    for (const k of Object.keys(root)) if (!isPlainObject(root[k])) delete root[k];
    const virt = isPlainObject(obj) && isPlainObject(obj[VIRTUAL_KEY]) ? Object.assign({}, obj[VIRTUAL_KEY]) : {};
    for (const [k, v] of this.folded) virt[k] = v;
    root[VIRTUAL_KEY] = virt;
    root[BLOCKED_KEY] = { at: this.now(), bytes: text.length, value: text.slice(0, BLOCKED_COPY_LIMIT) };
    return root;
  }

  /** Row 1 carries the keeper's mark. Confirm its key and adopt it. */
  adoptMarked(obj, text) {
    const mark = isPlainObject(obj) ? obj[MARK_KEY] : null;
    if (!isPlainObject(mark)) return false;
    const rk = mark.root === FALLBACK_ROOT_KEY ? FALLBACK_ROOT_KEY : ROOT_KEY;
    return this.probeIs(rk, text) ? this.adopt(rk) : false;
  }

  adopt(rootKey) {
    this.rootKey = rootKey;
    this.blocked = rootKey === FALLBACK_ROOT_KEY;
    const root = this.readRootAny();
    if (root && !isPlainObject(root[MARK_KEY])) this.writeRoot(root);
    return true;
  }

  /** Row 1 parsed without requiring the mark. Start-up only. */
  readRootAny() {
    const obj = parse(this.engine.get(this.rootKey));
    return isPlainObject(obj) ? obj : null;
  }

  locate() {
    if (this.engine.length() === 0) return;
    for (let i = 0; i < MAX_FOLD_STEPS; i++) {
      const r = this.foldStep();
      if (r === true) {
        this.finishFold();
        if (this.blocked) this.tryToLeaveBlockedMode();
        this.tidy();
        return;
      }
      if (r === false) return;
    }
    this.blockedMode(this.engine.get(ROOT_KEY) || "");
  }

  /**
   * In fallback mode the rows behind the root are the ones that could not be identified last time. Lift the root,
   * whose text is in memory, look at what is behind it with the current key list, and if everything can be identified
   * or the way is clear, move back to "modSettings". The sections found there are kept. The fallback root's newer
   * sections win.
   */
  tryToLeaveBlockedMode() {
    const ours = this.engine.get(FALLBACK_ROOT_KEY);
    const ourRoot = parse(ours);
    if (!ours || !isPlainObject(ourRoot)) return;
    this.engine.remove(FALLBACK_ROOT_KEY);
    const way = this.peelBehind();
    if (!way.clear) {
      this.engine.set(FALLBACK_ROOT_KEY, ours);
      for (const [k, v] of way.pulled) this.setVirtual(k, v);
      return;
    }
    this.migrateToRoot(ourRoot, way);
  }

  /** Identify and lift the rows behind a lifted fallback root. `clear` means the way to "modSettings" is open. */
  peelBehind() {
    const pulled = [];
    for (let i = 0; i < MAX_FOLD_STEPS; i++) {
      const text = this.engine.get(ROOT_KEY);
      if (text == null) return { clear: true, pulled, behind: null };
      const obj = parse(text);
      const k = this.identify(obj, text);
      if (k) {
        pulled.push([k, text]);
        this.engine.remove(k);
        continue;
      }
      if (this.engine.length() !== 1) return { clear: false, pulled, behind: null };
      if (looksLikeRoot(obj) && this.probeIs(ROOT_KEY, text)) return { clear: true, pulled, behind: obj };
      this.engine.clear();
      return { clear: true, pulled, behind: this.rootFromUnnamed(text) };
    }
    return { clear: false, pulled, behind: null };
  }

  migrateToRoot(ourRoot, way) {
    this.rootKey = ROOT_KEY;
    this.blocked = false;
    const behind = way.behind;
    const merged = behind ? withoutInternals(behind) : {};
    Object.assign(merged, withoutInternals(ourRoot));
    const behindVirt = behind && isPlainObject(behind[VIRTUAL_KEY]) ? behind[VIRTUAL_KEY] : {};
    const virt = Object.assign({}, behindVirt, ourRoot[VIRTUAL_KEY] || {});
    for (const [k, v] of way.pulled) virt[k] = v;
    merged[VIRTUAL_KEY] = virt;
    merged[MARK_KEY] = { v: VERSION, root: ROOT_KEY, since: this.now() };
    this.writeRoot(merged);
    const moved = way.pulled.length ? ", moved " + way.pulled.map(([k]) => k).join(", ") : "";
    this.log("warn", "left fallback mode: root is modSettings again" + moved);
  }

  /**
   * Housekeeping once the root is row 1. A kept copy of an unidentified row whose key is known by now moves under
   * that key. Raw rows hidden behind the root for keys the root already holds are older copies nobody can read, so
   * they are removed. The real store is then one row, and the "clear() when length > 1" helpers stay quiet even if
   * the keeper is removed later. removeItem is keyed, so none of this reads anything.
   */
  tidy() {
    const root = this.readRootAny();
    if (!root) return;
    if (this.reclaimBlocked(root)) this.writeRoot(root);
    if (this.engine.length() > 1 && !this.blocked) this.dropStaleRows(root);
  }

  /** @returns {boolean} Whether the kept copy of an unidentified row was moved under a key known by now. */
  reclaimBlocked(root) {
    const blocked = root[BLOCKED_KEY];
    if (!isPlainObject(blocked) || typeof blocked.value !== "string") return false;
    const obj = parse(blocked.value);
    const hits = this.known.filter((e) => safeMatch(e, obj, blocked.value));
    const virt = isPlainObject(root[VIRTUAL_KEY]) ? root[VIRTUAL_KEY] : (root[VIRTUAL_KEY] = {});
    // a mod whose data is already held is not missing anything. The copy is a stray duplicate, not its lost row.
    if (!hits.length || hits.some((e) => virt[e.key] !== undefined)) return false;
    const hit = hits[0];
    virt[hit.key] = blocked.value;
    delete root[BLOCKED_KEY];
    this.log("warn", "the kept copy of an unnamed row is " + JSON.stringify(hit.key) + " now; moved under that key");
    return true;
  }

  dropStaleRows(root) {
    const held = isPlainObject(root[VIRTUAL_KEY]) ? Object.keys(root[VIRTUAL_KEY]) : [];
    const before = this.engine.length();
    for (const k of held) if (!this.isRootName(k)) this.engine.remove(k);
    const gone = before - this.engine.length();
    if (gone) this.log("warn", "removed " + gone + " stale row(s) hiding behind the root");
    const left = this.engine.length() - 1;
    if (left > 0) this.log("warn", left + " unreadable row(s) of unknown keys remain behind the root");
  }

  /** Write one virtual key through the normal path. Start-up helper. */
  setVirtual(k, v) {
    this.setCache(null, null);
    this.setItem(k, v);
  }

  // ---- the virtual store ------------------------------------------------------------------------------------------

  isRootName(k) {
    return k === ROOT_KEY || k === this.rootKey;
  }

  getItem(k) {
    const key = String(k);
    const root = this.readRoot();
    if (!root) return null;
    if (this.isRootName(key)) return this.publicText(root);
    const virt = root[VIRTUAL_KEY];
    const v = isPlainObject(virt) ? virt[key] : undefined;
    return typeof v === "string" ? v : null;
  }

  setItem(k, v) {
    const key = String(k);
    const text = String(v);
    const root = this.readRoot();
    if (!root) return this.log("error", "write of " + JSON.stringify(key) + " refused: store unreadable");
    if (this.isRootName(key)) return this.setRoot(root, text);
    const virt = isPlainObject(root[VIRTUAL_KEY]) ? root[VIRTUAL_KEY] : {};
    const old = virt[key];
    const delta = typeof old === "string" ? text.length - old.length : text.length + key.length + 6;
    this.guard(root, key, delta, null);
    this.estBytes += delta;
    virt[key] = text;
    root[VIRTUAL_KEY] = virt;
    this.clearRefusal(root, key);
    this.writeRoot(root);
  }

  /** A write of "modSettings". The public sections are replaced and the keeper's fields are carried over. */
  setRoot(root, text) {
    const parsed = parse(text);
    if (!isPlainObject(parsed)) return this.log("error", "write of modSettings refused: not a JSON object");
    const next = withoutInternals(parsed);
    const delta = text.length - (this.publicText(root) || "").length;
    this.guard(root, ROOT_KEY, delta, () => this.culpritSection(next, root));
    this.estBytes += delta;
    for (const ik of INTERNAL) if (root[ik] !== undefined) next[ik] = root[ik];
    this.writeRoot(next); // a shared-row refusal is cleared from the Options row only; every mod writes this key
  }

  removeItem(k) {
    const key = String(k);
    const root = this.readRoot();
    if (!root) return;
    if (this.isRootName(key)) {
      const next = {};
      for (const ik of INTERNAL) if (root[ik] !== undefined) next[ik] = root[ik];
      this.writeRoot(next);
      return;
    }
    if (isPlainObject(root[VIRTUAL_KEY]) && key in root[VIRTUAL_KEY]) {
      this.estBytes -= jsonLength(root[VIRTUAL_KEY][key]);
      delete root[VIRTUAL_KEY][key];
      this.writeRoot(root);
    }
  }

  /**
   * The player's way out of fallback mode. Drop the rows that could not be identified, keep everything the keeper
   * holds, every section and every key, and write it all back as the one normal row.
   * @returns {{removedRows: number, keptSlices: number, keptKeys: number}}
   */
  rebuild() {
    const root = this.readRoot() || {}; // includes a write still queued for this task
    this.pending = null;
    const removedRows = Math.max(0, this.engine.length() - 1);
    this.engine.clear();
    this.setCache(null, null);
    this.blocked = false;
    this.rootKey = ROOT_KEY;
    const kept = Object.assign({}, root);
    delete kept[MARK_KEY];
    this.flushRoot(kept);
    const keptSlices = Object.keys(withoutInternals(kept)).length;
    const keptKeys = isPlainObject(kept[VIRTUAL_KEY]) ? Object.keys(kept[VIRTUAL_KEY]).length : 0;
    this.log("warn", "rebuilt: " + removedRows + " unnamed row(s) dropped, " + keptSlices + " slices and " + keptKeys + " keys kept");
    return { removedRows, keptSlices, keptKeys };
  }

  /** Empties the real store and writes the root back with the other mods' keys kept. Also leaves fallback mode. */
  clear() {
    const root = this.readRoot(); // includes a write still queued for this task
    this.pending = null;
    const virt = root && isPlainObject(root[VIRTUAL_KEY]) ? root[VIRTUAL_KEY] : {};
    this.engine.clear();
    this.setCache(null, null);
    this.blocked = false;
    this.rootKey = ROOT_KEY;
    const next = {};
    if (Object.keys(virt).length) next[VIRTUAL_KEY] = virt;
    this.writeRoot(next);
    this.log("warn", "store cleared; root rewritten with " + Object.keys(virt).length + " kept keys");
  }

  /** Always null, as the engine answers. A loop that lists every key to remove it stays a no-op, as it always was. */
  key(_i) {
    return null;
  }

  length() {
    return this.engine.length() > 0 ? 1 : 0;
  }

  // ---- patch -----------------------------------------------------------------------------------------------------

  status() {
    this.flush();
    const root = this.readRoot();
    const virt = root && isPlainObject(root[VIRTUAL_KEY]) ? Object.keys(root[VIRTUAL_KEY]) : [];
    return {
      version: VERSION,
      rootKey: this.rootKey,
      blocked: this.blocked,
      foreign: this.foreign,
      rows: this.engine.length(),
      lengthShadowed: this.engine.canShadowLength,
      folded: this.folded.map(([k]) => k),
      virtualKeys: virt,
      slices: root ? Object.keys(withoutInternals(root)) : [],
      blockedBytes: root && root[BLOCKED_KEY] ? root[BLOCKED_KEY].bytes : 0,
      rowBytes: this.estBytes,
      limitBytes: this.limit,
      refused: this.refusal(root)
    };
  }

  patch() {
    const ls = this.ls;
    const def = (n, value) =>
      Object.defineProperty(ls, n, { value, writable: true, configurable: true, enumerable: false });
    for (const n of ["getItem", "setItem", "removeItem", "clear", "key"]) def(n, this[n].bind(this));
    if (this.engine.canShadowLength) {
      Object.defineProperty(ls, "length", { get: () => this.length(), configurable: true, enumerable: false });
    }
    const api = {
      build: BUILD, origin: this.origin, status: () => this.status(), uninstall: () => this.uninstall(),
      engine: this.engine, rootKey: () => this.rootKey, flush: () => this.flush(), rebuild: () => this.rebuild(),
      limitBytes: this.limit, dismissRefusal: () => this.dismissRefusal()
    };
    def("__settingsKeeper", api);
    this.sync = false;
    return api;
  }

  uninstall() {
    this.flush();
    this.sync = true;
    for (const n of ["getItem", "setItem", "removeItem", "clear", "key", "length", "__settingsKeeper"]) delete this.ls[n];
  }
}

/**
 * Several mods may carry this file, and the newest build wins. An older installed copy writes out anything it still
 * holds and uninstalls. An equal or newer one is kept.
 * @returns {boolean} Whether this copy should install over the one found.
 */
function takeOver(current, opts) {
  if (!(typeof current.build === "number" && current.build < BUILD)) return false;
  if (typeof current.flush === "function") current.flush();
  if (typeof current.uninstall === "function") current.uninstall();
  if (typeof opts.log === "function") {
    opts.log("warn", "build " + current.build + " from " + (current.origin || "?") + " replaced by build " + BUILD +
      " from " + (opts.origin || "?"));
  }
  return true;
}

/**
 * Install the keeper on a Storage-like object. A second call returns the keeper already installed.
 * @param {Storage} ls The engine's localStorage.
 * @param {{log?: Function, knownKeys?: Array<{key: string, match: Function}>, now?: Function}} [opts]
 * @returns {object|null} The keeper's API, or null when there is nothing to patch.
 */
export function install(ls, opts = {}) {
  if (!ls) return null;
  const current = ls.__settingsKeeper;
  if (current && !takeOver(current, opts)) return current;
  const keeper = new Keeper(ls, opts);
  keeper.locate();
  return keeper.patch();
}

// ---- keys other mods write on their own, with a content check for each -------------------------------------------
// At start-up the keeper may find a foreign row sorting before "modSettings". It can move that row only if it knows
// the row's key, because removeItem is keyed and nothing can list the store. Each entry names a key and a strict
// check of the row's parsed content. The key is tried only when the check passes, because trying a key the row does
// not belong to would overwrite a hidden row of that name. Keys whose content cannot be recognised are left out on
// purpose. An unrecognised row puts the keeper into fallback mode rather than risk another mod's data. Where two keys
// share a shape, the one that sorts first is listed first, since it would be row 1.

const obj = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/** ozq Chronicle's own store (before 0.31) and History and Rankings hold the same {v, updated, games} archive. */
const archive = (o) => obj(o) && typeof o.v === "number" && "updated" in o && obj(o.games);

/** AutoMissionary's settings: flat booleans. */
const autoMissionary = (o) => obj(o) && "autoSpread" in o && "targetCityStates" in o && "ignoreAsleep" in o;

export const KNOWN_KEYS = [
  { key: "!chronicle", match: archive },
  { key: "AutoMissionary.settings.v1", match: autoMissionary },
  { key: "AutoMissionary.settings.v2", match: autoMissionary },
  { key: "htlData", match: archive },
  { key: "tmt-compact-policy-cards", match: (o) => obj(o) && obj(o._settings) && Object.keys(o).every((k) => k === "_settings" || obj(o[k])) }
];

// ---- self-install, in the main menu and in the game ---------------------------------------------------------------
// The mod loader does not promise script order. A mod that reads localStorage at module load before this ran got the
// engine's answer once. Every call after this goes through the keeper, including calls on a reference captured
// earlier, because the object is patched in place rather than replaced.
const TAG = "[settings-keeper]";

function log(level, msg) {
  try {
    (level === "error" ? console.error : console.warn)(TAG + " " + msg);
  } catch (_) {
    /* no console */
  }
}

/** Which mod's folder this copy runs from, for the log line. Several mods may carry the file. */
function originOfThisCopy() {
  try {
    const u = String(import.meta.url);
    const m = /^[a-z]+:\/\/[^/]+\/([^/]+)\//i.exec(u);
    return m ? m[1] : u;
  } catch (_) {
    return "";
  }
}

try {
  const ls = typeof localStorage !== "undefined" ? localStorage : null;
  const api = install(ls, { log, knownKeys: KNOWN_KEYS, origin: originOfThisCopy() });
  if (!api) log("error", "no localStorage in this context");
  else {
    const s = api.status();
    log("warn", "ready (build " + api.build + " from " + (api.origin || "?") + "): root " + JSON.stringify(s.rootKey) + ", rows " + s.rows + ", slices " + s.slices.length +
      ", keys kept " + s.virtualKeys.length + ", " + Math.round(s.rowBytes / 1024) + " KB" +
      (s.refused ? ", a write by " + JSON.stringify(s.refused.by) + " was refused for size" : "") +
      (s.folded.length ? ", moved " + s.folded.join(", ") : "") +
      (s.blocked ? ", BLOCKED by an unnamed row of " + s.blockedBytes + " bytes" : "") + (s.lengthShadowed ? "" : ", length not shadowed"));
    try {
      window.SettingsKeeper = api;
    } catch (_) {
      /* no window */
    }
  }
} catch (e) {
  log("error", "install failed: " + e);
}
