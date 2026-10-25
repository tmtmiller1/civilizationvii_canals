// run.mjs <old|new> <scenario>: play one scenario of tests/trace/scenarios.mjs against the fake engine and print its
// trace as JSON. "old" is ui/canals.js as it was at the revision REF names (default 358d1e3, the last single-file
// script); "new" is the modules in ui/. Each run is its own process, so no module state carries over.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeEngine } from "./engine.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const [version, name] = process.argv.slice(2);
const UI = process.env.CANALS_UI || path.join(ROOT, "ui"); // "new" from a scratch copy, to check a break is caught
const sc = SCENARIOS[name];
if (!sc) { console.log(JSON.stringify({ error: `no scenario ${name}` })); process.exit(2); }

const STUBS = { "/core/ui/dialog-box/manager-dialog-box.js": "stub-dialog.mjs", "/core/ui/options/model-options.js": "stub-options.mjs" };
registerHooks({
  resolve: (spec, ctx, next) => {
    if (STUBS[spec]) return { url: pathToFileURL(path.join(HERE, STUBS[spec])).href, shortCircuit: true };
    if (spec.startsWith("/tower-canals/ui/"))
      return { url: pathToFileURL(path.join(UI, spec.slice("/tower-canals/ui/".length))).href, shortCircuit: true };
    return next(spec, ctx);
  }
});

async function load() {
  globalThis.__canals = { fake: true }; // keeps the script's own install() from running at load
  if (version === "old") {
    const ref = process.env.REF || "358d1e3";
    let src = execFileSync("git", ["-C", ROOT, "show", `${ref}:ui/canals.js`], { encoding: "utf8" });
    const names = [...src.matchAll(/^(?:async function |function |const |let )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    src += `\nexport { ${[...new Set(names)].join(", ")} };\n`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canals-old-"));
    fs.writeFileSync(path.join(dir, "canals.mjs"), src);
    try { return await import(pathToFileURL(path.join(dir, "canals.mjs")).href); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const all = { ...(await import(pathToFileURL(path.join(UI, "canals.js")).href)) };
  for (const f of fs.readdirSync(UI).filter((x) => /^canals-[a-z]+\.js$/.test(x) && !/-(options|shell)\./.test(x)))
    Object.assign(all, await import(pathToFileURL(path.join(UI, f)).href));
  return all;
}

const eng = makeEngine(sc.map, sc.options || {});
eng.install();
globalThis.__traceNote = (m) => eng.trace.push(`${String(eng.now).padStart(6)} ${m}`);
const out = console.log.bind(console);
const M = await load();
if (sc.setup) sc.setup(eng, M);
// the act runs on the virtual clock, so it's started, the clock is run, and then its result is read
let result;
const acted = Promise.resolve().then(() => sc.act(M, eng))
  .then((r) => { result = r; }, (e) => { result = `threw ${e && e.message}`; });
await eng.run(sc.limit || 120000);
await acted;
out(JSON.stringify({ result: result === undefined ? null : result, trace: eng.trace, state: eng.state() }));
