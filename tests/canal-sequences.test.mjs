// canal-sequences.test.mjs - Canals: every engine sequence the mod runs (opening a Canal, the order, the repairs, the
// sweep, the site markers, the save wrap, install) played against a fake engine on a virtual clock, once with the
// single-file script as it was at 358d1e3 and once with the modules in ui/, and the two traces compared: every engine
// call with its time, every log line, the result, and the map and records at the end. A change that keeps the steps,
// the waits and their order gives the same trace. Scenarios: tests/trace/scenarios.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./trace/scenarios.mjs";

const run = promisify(execFile);
const RUNNER = fileURLToPath(new URL("./trace/run.mjs", import.meta.url));
const play = async (version, name) => JSON.parse((await run(process.execPath, [RUNNER, version, name],
  { maxBuffer: 64 << 20 })).stdout);

// The old script held the engine's autosave (frequency 1000 + the player's) and wrote its own; the modules leave the
// autosave to the engine and land the canals at TurnEnd (te1). Those lines differ in every scenario that opens a canal
// or installs, so they are taken out of both traces before the comparison, and the frequency line out of the state;
// the new state has to show the player's own frequency, never a held one.
const AUTOSAVE_GONE = [/Configuration\.setAutoSaveFrequency 1001$/, /log \[Canals\] autosave: every /, /engine\.(on|off) PlayerTurnDeactivated$/];
const AUTOSAVE_CAME = [/engine\.(on|off) (TurnEnd|TurnBegin)$/];
const FREQUENCY = /^autosave frequency=/;
const strip = (lines, res) => lines.filter((l) => !res.some((re) => re.test(l)));

// A scenario that names `changed` is one where the modules deliberately do more than the old script (the buildings a
// failed Canal order took off, put back): the lines it lists as added are taken out of the new trace, and the state
// lines it names out of both, before the comparison, and its check says what the new lines must show. One marked
// `only: "new"` plays code the old script doesn't have, and its check alone decides.
for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`sequence: ${name}`, async () => {
    if (sc.only === "new") {
      const now = await play("new", name);
      assert.ok(!String(now.result).startsWith("threw"), `threw: ${now.result}`);
      assert.ok(sc.check(now), "the new behaviour shows in the trace and the state:\n" + now.state.join("\n"));
      return;
    }
    const [was, now] = await Promise.all([play("old", name), play("new", name)]);
    assert.ok(was.trace.length > 0, "the old script did something");
    assert.ok(!String(was.result).startsWith("threw"), `the old script threw: ${was.result}`);
    const ch = sc.changed;
    const trace = strip(ch ? now.trace.filter((l) => !ch.added.some((re) => re.test(l))) : now.trace, AUTOSAVE_CAME);
    const keep = (st) => strip(ch ? st.filter((l) => !ch.state.test(l)) : st, [FREQUENCY]);
    assert.deepEqual(trace, strip(was.trace, AUTOSAVE_GONE), "the same engine calls, waits and log lines, at the same times");
    assert.deepEqual(now.result, was.result, "the same result");
    assert.deepEqual(keep(now.state), keep(was.state), "the same map and records at the end");
    const freq = now.state.find((l) => FREQUENCY.test(l));
    assert.ok(freq && Number(freq.split("=")[1]) < 1000, "the autosave frequency is the player's: " + freq);
    if (ch) assert.ok(ch.check(now), "the change shows:\n" + now.state.join("\n"));
  });
}
