# Splitting ui/canals.js

Status: first cut, 2026-10-15. Nothing has moved. The move waits on an AI soak on the 1.5.x build and on the owner, so
the behaviour it has to keep is watched first. Tests for the rule and geometry code are in `tests/canal-rules.test.mjs`
(23 tests on a fake map, `npm run rules`); each was checked to fail when the code it covers is broken in a scratch copy.

`ui/canals.js` is 1,676 code lines against the 500-line lint limit, with 48 lint warnings. The build and save paths are
watched behaviour: a retype during a save crashed in `c71`, the house flicker came from the old commit path, and `we3`
crashed once with the works dust on. So the split moves code and keeps everything else as it is, in this order:

1. Tests first (done for the pure code, see above).
2. A move-only split, function bodies byte for byte the same.
3. The pure functions broken up under the tests.
4. The async sequences, one per commit, each watched with its probe. Ask the owner before this step.
5. The lint rules raised to "error" and the `eslint.config.js` comment rewritten (its TODO names `districtThenBuild`,
   which 1.5.0 removed, and its "499 counted lines" note is out of date).

If the owner would rather leave the engine sequences alone, stop after step 2 and put documented `eslint-disable` lines
on those functions.

## The modules, first cut

Code lines are counted the way the lint rule counts them (blank and comment lines left out), from the 1.5.3 file.

| Module | Code lines | What moves there |
| --- | --- | --- |
| `ui/canals-state.js` | ~61 | The constants (`TAG`, `KEY`, the GameConfiguration keys, `CANAL_TYPES`, `ONE_TILE`, `SETTLE_MS`, `PLACE_MS`, `BUILD_RADIUS`), `log`, `safe`, `sleep`, `J`, `modeRead` with `oneTileMode`, the `state` object, `canalIndex`, `saveInFlight`, `withBlock`, the pending and open records (`loadPending` to `rememberOpen`), `AGE_RANK` with `ageRank` |
| `ui/canals-map.js` | ~109 | Map reads and the water helpers: `idx` to `isCuttable`, `currentAge`, `isParkland` |
| `ui/canals-rule.js` | ~105 | The site rule and the AI's worth: `CHAIN_RULES`, `ruleFor`, `placementRule`, `canalPlots`, `isNaturalWater`, `isIsthmus`, `waterSides`, `sailFrom`, `pairWorth`, `canalWorth` and their constants |
| `ui/canals-look.js` | ~259 | The works dust (`WORKS_VFX`, `showWorks`, `hideWorks`), the channel geometry (`waterSideIndexes` to `runArms`) and the drawing (`orderSides` to `redrawNeighbours`) |
| `ui/canals-open.js` | ~153 | `flipToCoast`, `localTurnActive`, `notThisTurn`, `keepRuralTile`, `openCanal`, the district helpers (`districtHolder`, `owningCity`, `destroyDistrict`, `createRuralDistrict`), `settleCanalTile` |
| `ui/canals-repair.js` | ~163 | `repairCitylessDistricts`, `healDistrict`, `queuedHere`, `requeue`, `heldByOwnersCity`, `healCanalTile`, `repairCanalTile` and their constants |
| `ui/canals-save.js` | ~170 | `retypeCanals` to `keepLandLook`: the save wrap, age end, the autosave hold and the Options slider wrap |
| `ui/canals-placement.js` | ~293 | `plotOf` to `wrapHost`: `isObsolete`, `enginePlots`, `eligiblePlots`, pricing, the `canStart`, `canStartQuery` and `sendRequest` wraps, `placeCanal` |
| `ui/canals-sites.js` | ~156 | `aiMajors` to `syncSites`: the markers, the queued orders, `aiSites` |
| `ui/canals.js` | ~205 | The header comment, `onTurnActivated`, `sweep`, `onBuildCompleted`, the notices and the reload offer, `install`, `uninstall`, the `__canals` global, and the parked ship limit (`TRANSIT_LIMIT`, `wrapUnitSend`) |

## Things the move has to get right

- Every new file goes into `ImportFiles` in the `canals-game` group of `canals.modinfo`, imported the way
  `canals-settings.js` is (`/tower-canals/ui/<file>.js`). A missing entry means the mod loads but its hooks never
  install, and the game doesn't say why.
- `release.sh` audits the zip against an allow-list. Its UI line names `canals-(shell|options|settings)` only, so each
  new file has to be added there (or the pattern widened to `canals(-[a-z]+)?\.js`), or the release stops. Add each
  file to the `check` script in `package.json` too.
- The module-level `let`s need one owner each: `WORKS_VFX` in `canals-look.js` (the `__canals.worksVfx` setter has to
  reach it, so the look module exports a setter), `modeRead` in `canals-state.js`, `wonderFeatures` and
  `impassableFeatures` in `canals-map.js`, `engineListCache` in `canals-placement.js`.
- The modules import each other in a circle (placement uses the sites' markers, and the sites use `eligiblePlots`;
  opening uses `isObsolete` and `drawOverlay`). ES modules allow that as long as only `install()` in `canals.js` runs at
  load time, and that file loads last. Shared constants (`SITE_FEATURES`, `AGE_RANK`, `CANAL_TYPES`) go in
  `canals-state.js` so every module reads them after they've been set.
- `rememberOpen` calls `holdEngineAutosave`, so the records in `canals-state.js` would import the save module. Pass it
  in, or keep `rememberOpen` with the save code; either way it stays one call in the same place in `openCanal`.
- `tests/fake-game.mjs` rewrites the one import in `canals.js` and adds an export line to a temporary copy. After the
  split the modules export their functions themselves, and the loader should map every `/tower-canals/` import to the
  repo (a `module.registerHooks` resolve hook does it without copying files).
- Comments to fix on the way: `canals.js:1904` still calls the rule "a strip of land between two shores", and the
  install log line says "limited to isthmus tiles".
- Found while writing the tests: in `isIsthmus` the early `if (rule.max <= 1) return false;` is redundant: a tile beside
  a canal already makes a run of two, which the run-size check refuses under a limit of one. Keep it in the move; step 3
  may drop it.

## Watching it

The move-only split is watched with the crash-soak probes, each on the vanilla side (`tools/crash-soak/run-soak.sh`,
`MOD=canals`, every other mod off) and the usual-set side (`tower-bench lab`, the registry as it is):

- `wm-game.js`, Exploration seed 9001: purchase and production on a worked rural tile, a town's tile, a bare tile,
  short of gold, and an urban tile holding only an earlier-age building.
- `cm-game.js`: the same commits through to an open canal.
- `sv-game.js` then `ld-game.js`: a save with a canal open and one pending, loaded again.
- `ot-game.js`: one-tile mode in each age.

Each run's `[Canals]` lines should match the 1.5.3 runs line for line, apart from times and ids.
