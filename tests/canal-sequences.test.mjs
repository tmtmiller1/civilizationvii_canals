// canal-sequences.test.mjs - Canals: every engine sequence the mod runs (opening a Canal, the order, the repairs, the
// sweep, the site markers, the save wrap, install) played against a fake engine on a virtual clock, once with the
// single-file script as it was at edf7c8b and once with the modules in ui/, and the two traces compared: every engine
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
    const trace = ch ? now.trace.filter((l) => !ch.added.some((re) => re.test(l))) : now.trace;
    const keep = (st) => (ch ? st.filter((l) => !ch.state.test(l)) : st);
    assert.deepEqual(trace, was.trace, "the same engine calls, waits and log lines, at the same times");
    assert.deepEqual(now.result, was.result, "the same result");
    assert.deepEqual(keep(now.state), keep(was.state), "the same map and records at the end");
    if (ch) assert.ok(ch.check(now), "the change shows:\n" + now.state.join("\n"));
  });
}
