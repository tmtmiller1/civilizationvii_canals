# Splitting ui/canals.js

Status, 2026-10-16: all five steps done offline, none of it watched in a game yet. The AI soak the split waited on ran
first (`s13` in `verification-runs.md`, on `d3f2712`); the owner OK'd step 4 the same day.

`ui/canals.js` was 1,676 code lines against the 500-line lint limit, with 48 lint warnings. The build and save paths
are watched behaviour: a retype during a save crashed in `c71`, the house flicker came from the old commit path, and
`we3` crashed once with the works dust on. So the split moves code and keeps everything else as it is, in this order:

1. Tests first. Done 2026-10-15 (`tests/canal-rules.test.mjs`), added to on 2026-10-16 (below).
2. A move-only split, function bodies byte for byte the same. Done 2026-10-16.
3. The pure functions broken up under the tests. Done 2026-10-16.
4. The async sequences, each checked against the old script by a trace test. Done 2026-10-16; the probes that watch
   them in a game are still owed (below).
5. The lint rules raised to "error" and the `eslint.config.js` comment rewritten. Done 2026-10-16: 0 problems.

## The modules

Code lines counted the way the lint rule counts them (blank and comment lines left out), after step 4 and the
put-back below.

| Module | Code lines | What's in it |
| --- | --- | --- |
| `ui/canals.js` | 230 | The header comment, `install`, `uninstall`, the `__canals` object, the notices and the reload offer, the turn-start hook, the build-completed hook, the parked ship limit (`TRANSIT_LIMIT`, `wrapUnitSend`) |
| `ui/canals-state.js` | 59 | The constants, `log`, `safe`, `sleep`, `J`, the one-tile mode read, the pending and open records, the `state` object, `withBlock`, `AGE_RANK` |
| `ui/canals-map.js` | 117 | Map reads and the water helpers, `isParkland`, `currentAge` |
| `ui/canals-rule.js` | 113 | `isIsthmus` and the age's run rules, `canalWorth` and the AI's worth helpers |
| `ui/canals-look.js` | 298 | The works dust (`WORKS_VFX` with `setWorksVfx`), the channel geometry and the drawing |
| `ui/canals-open.js` | 186 | `flipToCoast`, `openCanal`, `keepRuralTile`, the district helpers, `settleCanalTile` |
| `ui/canals-repair.js` | 250 | `sweep`, `repairCitylessDistricts`, `healDistrict`, `requeue`, `healCanalTile`, `repairCanalTile` |
| `ui/canals-save.js` | 187 | `rememberOpen`, the save wrap, the age's end, the held autosave, the Options slider wrap, `keepLandLook` |
| `ui/canals-placement.js` | 402 | `isObsolete`, `plainBuilding`, `enginePlots`, `eligiblePlots`, pricing, the `canStart`, `canStartQuery` and `sendRequest` wraps, `placeCanal`, and the put-back of what a failed Canal order took off |
| `ui/canals-sites.js` | 180 | The site markers, the queued orders, `aiSites`, `syncSites` |

Where this differs from the first cut, and why:

- Nothing imports `canals.js`. It's the script the game loads; if a module imported it under another path the game
  could run it twice. So `sweep` went to `canals-repair.js` (the save module's `keepLandLook` calls it) and the works
  dust to `canals-look.js` (`openCanal` and `placeCanal` call it). The `__canals.worksVfx` setter can't assign to an
  imported binding, so the look module has `setWorksVfx` and the setter calls it. That one line is the only change
  to the `__canals` object.
- `rememberOpen` is in `canals-save.js`, next to `holdEngineAutosave`, which it calls. That leaves
  `canals-state.js` importing nothing of the mod's own, so it's always fully loaded before anything that reads it.
- The modules import each other in a circle. That's safe because the only code that runs at load time is constant
  setup that reads `canals-state.js` or its own file, and `install()` in `canals.js`, which the game loads last.
  The test loader imports the files the same way, `canals.js` first.

## The move, proved

`devtools/split-proof.py` cuts the last one-file `canals.js` (`edf7c8b`) into its 213 top-level blocks, each
declaration with the comments above it, and looks for each one verbatim in the new files. On the move-only split, 212
were found in exactly one file. The 213th was the `__canals` object, for the setter line above. After step 3 it also
lists the functions that were broken up (below) and `aiMajors`, whose block carries the site-markers comment, which
was corrected (it still described the old two-shore rule). Every async engine sequence is still byte for byte the
1.5.3 code.

The imports were worked out by ESLint's `no-undef` on the moved files, not by hand, and the lint run after the move
had no errors and one warning fewer (47: `canals.js` was the only file over `max-lines`).

## Step 3: what was broken up

Each one with the tests green before and after:

- `isIsthmus`: the run it would join (`runJoined`) and the reach to natural water (`reachesNaturalWater`).
- `channelSides`: `shorePairs` and `everyPair`.
- `runArms`: `shoreTouches`, `shoreOf`, `branchToShores` and `branchFor`, in the same order of shores and branches.
- `drawOverlay`: `modelAdder`, `drawCanal` and `drawLayout`, the models added in the same order.
- `plainBuilding`: `placementColumn`. `enginePlots`: `offeredPlots`. `eligiblePlots`: `freshSite` and
  `inBuildReach`. `unlockedByMod`: `refusedForMore` and `neededNode`.

New tests went in first and passed on the moved 1.5.3 code: `tests/canal-placement.test.mjs` (which tiles are offered,
past the build ring, with units, with the engine's list, a queued tile; when the mod sells a locked Canal) and
`tests/canal-look.test.mjs`, which records every model `drawOverlay` adds for eight maps, four looks and four
variants (224 drawings, 1,111 models) and compares them with `tests/canal-look.snapshot.json`. Each test file was
checked to fail on a scratch copy with one rule broken (`CANALS_UI=<folder>` points the loader at a copy).
`tests/canals-modinfo.test.mjs` checks every imported module is in the game group's `ImportFiles`.

## Step 4: the engine sequences

Each one was split into named steps that keep the same order and the same awaits: `openCanal` (`openSite`,
`readyToOpen`, `siteBefore`, `recordAndDraw`, `rebuildAsRural`), `settleCanalTile` (`placeCitizen`), `placeCanal`
(`siteTaken`, `takeOffObsolete`, `canalLanded`, `landed`, `notTaken`), the `canStart`, `canStartQuery` and
`sendRequest` wraps, `repairCitylessDistricts`, `healDistrict`, `requeue`, `healCanalTile`, `repairCanalTile`, `sweep`,
`putFeature`, `syncSites`, `queuedCanalOrders`, `install`, `uninstall` and the parked `wrapUnitSend`.

They're checked by `tests/canal-sequences.test.mjs`. It plays 34 scenarios (`tests/trace/scenarios.mjs`) against a fake
engine (`tests/trace/engine.mjs`) where requests land after fixed delays on a virtual clock, once with `canals.js` as it
was at `edf7c8b` and once with the modules, and compares the two traces: every engine call and `canStart` question with
its time, every log line, the result, and the map and the save's records at the end. The scenarios cover openings on
rural and urban tiles, a boat that doesn't land, orders bought, built, refused, never placed and sold by the mod,
install and the whole order path through the wraps, a turn start, the age's end, every repair, the sweep, the site
markers, the save wrap and the parked ship limit. V8 coverage of the run left 7 lines of those functions unreached, all
guards for things the fake doesn't do (a host that can't be wrapped, a terrain the database lacks). The test fails on a
scratch copy with one step of `openCanal` moved.

It caught one change while this was done: an extracted step awaited on a path where the old code didn't, so a second
order running alongside sent its request a turn of the event loop earlier. Every extracted step is now awaited only
where the old code awaited. An extracted async step still adds a microtask turn when it returns; no engine call moves
in any scenario.

## The buildings a Canal order takes off

Owed since 2026-10-15: `placeCanal` takes an earlier-age building off its tile before the order is forwarded, and
never put it back if the Canal didn't come. The order stays as it was watched: the building still comes off at the
same point, and nothing new happens before the order goes. If the engine never takes the forwarded Canal, neither on
the map nor into the queue, `notTaken` makes the building again on the tile after the existing undo (`putBack`). A
building made by script on a district comes back finished and held by the city (`hl2`, the call `healDistrict`
uses).

Once the order is in, it's the game's rule. The game's own overbuild clears a tile when the building is queued
(`engine-closed.md`, `pj7`), and a building taken out of the queue stays on its tile unfinished (`rs1`), so cancelling
never brings the old one back; a Canal taken out of the queue leaves it gone the same way. (A first version also gave
the building back at the next turn start when a queued Canal left the queue before it showed on the map; the owner
chose the game's behaviour instead, and it came out before it was committed.)

`tests/canal-sequences.test.mjs` checks that the one scenario where this acts differs from the old script only by the
put-back lines; every other scenario, a production order over an old building included, is the old trace line for
line.

## Watching it

None of the above has run in a game. The checks are in `WATCH_LIST.md`, group 6b. The trace test runs the code against a
fake engine, so it holds the order of calls, not what the real engine does with them. Each one is run on the vanilla
side (`tools/crash-soak/run-soak.sh`, `MOD=canals`, every other mod off) and the usual-set side (`tower-bench lab`):

- `wm-game.js`, Exploration seed 9001: purchase and production on a worked rural tile, a town's tile, a bare tile,
  short of gold, and an urban tile holding only an earlier-age building.
- `cm-game.js`: the same commits through to an open canal.
- `sv-game.js` then `ld-game.js`: a save with a canal open and one pending, loaded again.
- `ot-game.js`: one-tile mode in each age.

Each run's `[Canals]` lines should match the 1.5.3 runs line for line, apart from times and ids. Before any of them,
`deploy --prove` should list all ten game files as served.

Comments still to fix: the install log line says "limited to isthmus tiles". It's left as it is until the probes
have run, since they compare the log line for line.
