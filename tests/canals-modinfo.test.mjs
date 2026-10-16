// canals-modinfo.test.mjs - Canals: the game loads a UI module another script imports only if the modinfo lists it
// under ImportFiles. A missing one leaves the mod installed with none of its hooks and no error, which no other test
// here would notice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => fs.readFileSync(root + p, "utf8");
const modinfo = read("canals.modinfo");
const group = (id) => {
  const g = modinfo.match(new RegExp(`<ActionGroup id="${id}"[\\s\\S]*?</ActionGroup>`));
  assert.ok(g, `no action group ${id}`);
  return g[0];
};
const items = (block, tag) => [...((block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || ["", ""])[1]
  .matchAll(/<Item>([^<]+)<\/Item>/g))].map((m) => m[1]);

/** Every ui/ file the game group's scripts import, followed through the imports from its UIScripts. */
function importedFrom(scripts) {
  const seen = new Set(); const todo = [...scripts];
  while (todo.length) {
    const f = todo.pop();
    for (const m of read(f).matchAll(/from "(?:\.\/|\/tower-canals\/ui\/)([\w-]+\.js)"/g)) {
      const dep = "ui/" + m[1];
      if (!seen.has(dep)) { seen.add(dep); todo.push(dep); }
    }
  }
  return seen;
}

test("modinfo: every module the game scripts import is in the game group's ImportFiles, and every listed file exists", () => {
  const game = group("canals-game");
  const scripts = items(game, "UIScripts");
  assert.ok(scripts.includes("ui/canals.js"), "canals.js is a game UIScript");
  const imported = importedFrom(scripts);
  assert.ok(imported.has("ui/canals-state.js") && imported.has("ui/canals-placement.js"), "the import scan found too little");
  const listed = items(game, "ImportFiles");
  for (const f of imported) assert.ok(listed.includes(f), `${f} is imported but not in ImportFiles`);
  for (const f of [...listed, ...scripts]) assert.ok(fs.existsSync(root + f), `${f} does not exist`);
});

test("modinfo: every game module in ui/ is imported, so none is left behind", () => {
  const imported = importedFrom(items(group("canals-game"), "UIScripts"));
  const modules = fs.readdirSync(root + "ui").filter((f) => /^canals-[a-z]+\.js$/.test(f) && !/-(options|shell)\./.test(f));
  for (const f of modules) assert.ok(imported.has("ui/" + f), `ui/${f} is in the folder but nothing imports it`);
});

test("modinfo: nothing imports canals.js, the script the game loads", () => {
  for (const f of fs.readdirSync(root + "ui").filter((x) => x.endsWith(".js"))) {
    assert.ok(!/from "(?:\.\/|\/tower-canals\/ui\/)canals\.js"/.test(read("ui/" + f)), `ui/${f} imports canals.js`);
  }
});
