# How the canal works, and the runs that proved each step

Every step below was watched on 2026-09-25 on Civilization VII 1.5.0. The runs live in
`mod_ideas_tested/canals/devtools/harness/` as `<label>-UI.log` with their captures in `shots/`; the analysis
that led to this design is `mod_ideas_tested/canals/REEXAMINATION-2026-09-25.md`. The reader-facing account is
the [README](../README.md); this file is the evidence behind it.

## The shape

1. **Placement.** The Canal buildings carry no terrain rule. `ui/canals.js` wraps `Game.CityOperations.canStart`:
   for a Canal the offered plots are the city's land tiles within its build ring (`BUILD_RADIUS`) that pass
   `isIsthmus`, and the per-plot check refuses anything else with `LOC_CANAL_NOT_ISTHMUS`. The engine's verdict
   on *whether* a Canal may be built (locked, already queued) is kept; the mod decides *where*.
2. **Commit.** The engine offers buildings only on tiles that already hold an urban district (`c7`: 4 urban plots
   offered, 8 rural land tiles never), so a Canal on a rural isthmus first gets one: `CREATE_ELEMENT {Kind:
   DISTRICT, Type: DISTRICT_URBAN}` lands in about 3 s, after which the Canal is offered there and a real BUILD
   queues it (`c7`, `c8`). The plot is remembered in the save (`Canals_Pending_v1`).
3. **Completion.** `ConstructibleBuildCompleted` fires for every player's buildings with the type hash, the
   constructible id and the tile (`c5b`, `c6`). For a Canal on a canal site the handler retypes the tile to Coast
   (`WorldBuilder.MapPlots.setTerrain` inside `startBlock`/`endBlock`, feature cleared first, lands in about
   110 ms), destroys the Canal and its urban district (the district's housing art would hide the canal, `c14`),
   buys the released plot back for the city, frees the Canal's citizen and places it with the city's own expand
   order (rural district, fishing boats, worker), re-creates the Canal on that rural district so its yields count
   (`c23`, `c25`), and draws the canal look (`c15`).
4. **The passage.** A ship's path to the far side went from 10 plots around the land to 3 plots through the tile,
   and a real move landed it there, its plot now in the other water area (`c4`); the same through a tile holding
   a quay and an urban district (`c5b`). The retype survives a cold save and reload (`c3`). The tile's area id
   does not change (the engine recalculates areas only at the age transition), which is why `isIsthmus` resolves
   a canal tile's waters through its neighbours instead of its area id.
5. **The look, in-session.** `WorldUI.createModelGroup().addModelAtPlot(asset, {i, j}, offset, {placement,
   followTerrain, scale, angle})` draws cooked assets on the hex at once (`c11` to `c13`). One
   `TER_Decal_RiverPiece_Straight` per ship-water side, angle `(360 - 60 x ring index) % 360` so the arm points at
   that side (the piece points east at 0 and turns counter-clockwise on screen), the age's props along the first
   arm, boats where the canal meets open water or a junction, and lock pieces at cliff shores. The plot list is
   kept in the save (`Canals_Open_v1`) and the overlays are redrawn on load and each turn.

## The runs, in order

| Run | Question | Observation |
| --- | --- | --- |
| `c1` | Is a flat tile retyped to Coast pathable by ships at once? | `setTerrain(TERRAIN_COAST)`; `Units.getPathTo` went from 0 to 2 plots; `MOVE_TO` landed. |
| `c3` | Does the retype persist on a cold reload? | Reload of the `c2` save: still Coast; the area id stays land. |
| `c3` | Is `Units.getPathTo` honest through fog? | Optimistic through unrevealed plots; only visible tiles count (control on visible land beside the Cog). |
| `c3`, `c4` | Does the production placement path see a retyped tile? | No: the Fishing Quay was offered on its 1 natural plot before and after; `CREATE_ELEMENT` placed a Quay on the retyped tile in 69 ms. |
| `c4` | The through-crossing, sea to sea, with the tile visible. | Spawned Cog: 10 plots around, 3 through; a real move landed it in the other water area. |
| `c5b` | Does a custom BUILDING type load, sit on the map as an urban district, and let ships cross? | `CREATE_ELEMENT` of the Canal, flip, swap, crossing, all fine. |
| `c5b`, `c6` | When do unlock grants fire? | At game creation, not on a loaded save: absent from production on the loaded save, listed on a Play Now game. |
| `c6` | A real BUILD of the Canal through the completion path. | The BUILD landed, `addProgress` completed it at once, the event carried the tile, the handler opened the canal. |
| `c7` | Which tiles does the engine offer a building? | Only existing urban districts (4 offered, 8 rural land tiles never); a script-created urban district makes a rural isthmus buildable. |
| `c5b`, `c7` | AI soak with the Canal unlocked for every major player. | 5 and 6 Autoplay turns, no crash, no AI Canal built. |
| `c8b`, `c8c`, `c8g` | How far from the centre will the engine take a BUILD? | A district 12 plots out is refused however long the wait; 2 plots out is taken (hence `BUILD_RADIUS`). |
| `c8b` | What happens to the plot when a script-created district is destroyed? | The plot is released from the city; the rollback buys it back. |
| `c8d`, `c8e`, `c8f` | Can a city be created by script for a probe? | The Tuner's `CREATE_ELEMENT {Kind: CITY}` does nothing in normal play; a spawned Settler's found-city op listed no valid plots at four sites. |
| `c8g` | The shipped mod through its own wraps and handler on a game created with it. | Seed 9001, Roma, isthmus 25,37: eligible list = that tile; wrapped offer = that tile; a plain urban tile refused with `LOC_CANAL_NOT_ISTHMUS`; commit created the district and queued the Canal; `addProgress` completed it; the handler opened the canal; a Cog crossed. |
| `c8h` | The placement rule as "water on at least two separate sides" (same sea on both sides counts, a headland does not). | Re-run end to end on the same seed, same result. |
| `c9`, `c9b` | Do navigable rivers count as a side? | A Cog on a river tile sailed through the canal to the sea (3 plots, 1 move left) and a fresh Cog sailed from the sea onto the river tile; before the flip the river Cog had a 0-plot path to the land tile and a 5-plot detour to the sea. |
| `c10` | How is the finished tile drawn after a cold reload? | As open water with the Fishing Quay on stilts; a Wharf added by `CREATE_ELEMENT` drew its warehouse at once; a Medieval Bridge showed nothing in one capture. |
| `c11`, `c12`, `c13` | Which shipped meshes draw a canal? | 13 + 10 + 5 candidates photographed. `TER_Decal_RiverPiece_Straight` and `_02` draw a water channel with banks; `STD_Major_River_1HEX_A` only river-bed rocks; the straight piece at 60 and 120 degrees rotates as expected but mirrored (fixed with `360 - 60 x index`); the two `VfxMesh_*_water` planes draw flat teal shapes; `GEN_ANT_Harbor_Pier_HB` a stone quay with cranes; `IMP_FishingBoat_River_I_W_O_E` moored boats with crates; `ANT_Bridge_Wooden_C` a whole bridge-town block; `STD_NAVIGABLE_RIVER`, `TER_RiverTerrain_Major_01`, `TER_Aquatic_Flat_SINGLE_A`, the flood decal and VFX nothing; `addModelBetweenPlots` returned null with plot pairs. |
| `c14` | The overlay drawn by the mod's own handler. | Hidden by the urban district's housing block (hence the district is destroyed on completion). |
| `c15` | The finished canal as a bare owned coast tile with the overlay. | Channel arms, quay, boats, the Cog sailing through it. |
| `c16` | Age dressing candidates. | `River_City_I_*_O_E` layouts draw houses along an empty river corridor (Modern variant with `_MOD_Attachments`); `GEN_ANT_Harbor_HB`, `GEN_MOD_Harbor_HB`, `MED_SPN_Wharf_HB`, `MID_ABB_Shipyard_HB` draw beside the arms. |
| `c17` | The three age compositions. | Antiquity harbour + quay + boats, Exploration houses + wharf + boats; the Modern composition drew nothing in an Exploration game. |
| `c18` | Can a yield-bearing building stay on the water tile? | A district re-created on the water tile still draws the land housing block, with the Canal and with a Fishing Quay alike; nothing on an urban district can stay without hiding the canal. |
| `c19` | The mod's own `drawOverlay` in a Modern-age game. | Modern, Exploration and Antiquity looks all drawn (Modern art needs the Modern age loaded). |
| `c20` | Earlier full pass with looks, gold hook and transit quota in the script. | Placement, district, build, completion, bare tile with the overlay, the Cog through the canal via the quota-wrapped move order. |
| `c21` | What does the retype do to cliffs? | Retyping a tile to Coast clears every cliff flag on it in the simulation (four edges to none); the unwired remove-cliffs effect changed nothing further; cliff rock faces stay drawn until the next load. |
| `c21`, `c22b` | Can a rural-only building be created on a bare tile? | Not by `CREATE_ELEMENT`; a rural district created first makes the engine add `IMPROVEMENT_FISHING_BOAT` itself, after which the works building lands beside it; an unworked rural tile adds no yield. |
| `c23` | The native worked-tile flow. | `addRuralPopulation(1)` gives a pending point; the city's own `EXPAND` order places it on the flipped tile (rural district, fishing boats, worker: food +3); the works building then adds its rows (food +3, gold +4), held over following turns and reflected in the treasury. |
| `c24` | Final pass with the native yields. | The handler freed the citizen, placed it by the expand order, created the works building, drew the overlay; city food +4, gold +4, population +1; the Cog crossed. |
| `c25` | The Canal as its own persistent building (rural-valid), the chain rule, cliffs allowed. | Fourteen Exploration sites offered around Roma; a coastal strip taken and opened as a worked fishing tile holding the Canal (food +4, gold +4); cliff tiles no longer excluded. |
| `c26` | Final pass with the occupied-tile guard. | Roma seed 9001 Exploration: thirteen sites offered (tiles holding buildings excluded); 28,38 opened as a worked fishing tile holding the Canal (food 33, gold 4); the opened tile no longer offered; no Unhandled errors in the log. |
| `c27`, `c27b`, `c27c` | A three-tile Exploration cut ordered in sequence through the real build path. | Roma seed 9001, 26,34 27,34 28,34: the third Canal was refused with `AlreadyExists` until the Buildings rows got `MultiplePerCity="true"` (bridges and walls are the base game's multiple-per-city buildings); then 3/3 opened, each opening redraws its opened neighbours so the channels meet, and the Cog's engine path ran through all three tiles (it stopped in the third for lack of moves). |
| `c28` | A Modern five-tile branching run. | No five-tile T-shape lay inside Roma's build ring (seed 9001), so the probe retyped one five tiles out and drew the mod's overlays: five channels linked at a three-way junction (no house layout on a junction); an Ironclad crossed trunk to branch end. |
| `c29` | Lock pieces at a cliff shore (25,37, cliff edges SE and NW). | With the ~20 s capture lag mapped by timestamps: the Saqiya canal decal draws as a white stone chamber with gates across the channel, the dockyard gate as a small gatehouse on the bank, the Norse mill piece as a water wheel; the coastline waterfall pieces draw as loose rock; the dockyard block covers the channel. |
| `c30` | Lock compositions at the cliff edge, one capture per candidate after a 24 s wait. | The capture lands ~33 s after the SHOT line, so each shot shows the next candidate (mapped by timestamps): the chamber at 0.40 along the arm is whole with a boat in it, at 0.50 and 0.60 it sinks into the cliff mesh; chamber + gatehouse + water wheel at both cliff shores reads as a lock; the dock piece draws nothing. |
| `c31` | The lock dressing through the mod's own completion path on the cliff isthmus 25,37. | Cliff shores SE and NW read before the retype and kept in the open record; chamber, gatehouse and wheel drawn at both shores; the Cog crossed. |
| `c32` | The three age looks with locks and ten waterfall candidates in a Modern game. | The camera drifted off the tile after the first capture (re-aim before every shot), and the props sat on the next channel arm instead of the dry bank: `orderSides` looked at ring index +1 where "left" of an arm is index -1 (fixed). |
| `c32b` | The same with the camera re-aimed. | The three age captures came out identical although each look was cleared and redrawn, and the waterfall sprays could not be matched to candidates: the render of an overlay change lands 15 to 35 s after the call. Verdict deferred to a slow pass. |
| `c34` | The slow pass on Roma's isthmus 25,37 in a Modern game, 45 s between change and capture. | `clearOverlay` does remove the models (bare farmland after each clear); the three age looks differ as designed with the harbour on the dry bank after the `orderSides` fix; of the waterfalls only the medium looping fall at 0.55 along the arm and z 0.5 shows (a white plume at the cliff foot); the mist shows nothing; the cliff-rock piece buries the site. |
| `c35` | The settlement-centre rule (a centre counts as a canal end). | A Cog moved from the coast tile south of Roma into Roma's centre (the engine lets ships enter a centre that touches coast); a canal beside the centre opened through the real path; a Cog on the navigable-river tile west of the centre got no path into it. |
| `scan-*` | Twelve seeds scanned for real use cases inside the capital's ring. | A cut whose ends touch different waters, rated by the smaller water's size and the biome: seed 9001 Roma joins the sea to a 27-tile navigable river at 25,37; seed 777 Pārsa has a grassland five-tile T joining ocean and river; seed 100 Paris a one-tile neck opening a 33-tile lake to the ocean; the rest reach ponds or nothing. |
| `gal-exp` | Gallery, Exploration seed 9001. | The three-tile cut 26,38 - 25,37 - 25,36 (Roma's estuary across the neck to the northern sea) through the real path, the Cog into and through it. Spawned ships were not removed between legs (ComponentID fix) and the lens manager is a module (import fix), so the pass was repeated. The "one-tile cliff canal" the harness added afterwards landed at 24,37, beside the cut's middle tile: four canals in a branched blob, which the rule of the day allowed because the opened canals' water made 24,37 a two-shore isthmus. Rule tightened (Exploration: a straight two-tile line, nothing else beside a canal) and the pass re-shot as `gal-exp3`. |
| `gal-mod` | Gallery, Modern seed 777. | Trunk 8,37 - 8,36 - 7,35 opened; the Ironclad crossed ocean to river through it. The first branch tile was offered but the engine dropped the BUILD with no reason code (state dump and retry added for the repeat). |
| `gal-ant3` | Gallery, Antiquity seed 9001. | The Antiquity start lands the settler at 59,37, far from Roma's 400 CE spot; the capital founded where it stood, one canal at 59,36 opened, the offer list after it held none of its neighbours (the Antiquity single-tile rule), the Galley went in and through, yield icons off. |

## Design decisions from the runs

- Yields: native, and the Canal is its own persistent building. The Canal costs a citizen (`Population` 1); on
  completion the mod frees it as a pending point and places it on the canal with the city's expand order (rural
  district, fishing boats, worker), then re-creates the same Canal type on that rural district (the type is valid
  on `DISTRICT_URBAN` for production and `DISTRICT_RURAL` for the finished tile), whose yield rows count in the
  city at once (`c23`, `c25`). No urban district, so no housing block (`c18`). A never-buildable hidden yield type
  was the earlier form (`c23`) and was folded into the Canal itself.
- Cliffs: the retype itself clears the plot's cliff flags (`c21`), so ships cross every edge; the cliff rock faces
  are drawn until the next load. Cliff edges are allowed (the earlier exclusion was reverted) and the README and
  Steam text say so.
- Chains: Antiquity keeps the single-tile two-shore rule. Exploration offers the tile that extends a canal (opened
  or queued) into a straight two-tile line, and nothing else beside a canal; Modern allows runs of up to five tiles
  with bends and branches, every tile reaching natural water through the run. A tile beside a canal is always
  judged as part of that run: the first gallery pass (`gal-exp`) showed that a canal's own water made its
  neighbours two-shore isthmuses, which let a fourth Canal onto the side of the three-tile cut and drew a branched
  blob, so the two-shore shortcut now applies only to tiles with no canal beside them. Tiles holding buildings are
  never offered, and a completed Canal sharing its tile with other buildings (an AI's, in an urban slot) is left
  alone.
- Transit quota: the local player's `MOVE_TO` orders through a canal are counted per turn and refused past the
  age's limit (1, 2, unlimited); AI movement is native and cannot be held.
- Looks: three per age, chosen by plot number so a canal keeps its look across reloads.

## What is not watched

- A refusal by the transit quota.
- A Modern branch through the real build path (`gal-mod` dropped that one BUILD with no reason code; branching
  was proved by retype in `c28`).
- The second and third look of each age as whole compositions; their pieces were photographed individually
  (`c16`, `c17`). The first look of each age was watched in a game of its own age (`gal-ant3`, `gal-exp`,
  `gal-mod`).
- A canal opening on an AI player's completion (the handler runs for any owner; the AI never built one in the
  soaks, which ran before the Canal had yields).
- The age transition with a canal on the map: the engine recalculates areas then, which should only make the
  canal more native.
- The hex mesh in-session: a retyped tile keeps its land mesh until the next load. After a cold reload the tile is
  drawn as water (`c10`), so the odd look is bounded by the next save-and-continue or age transition. No
  in-session redraw is known.
- Multiplayer: the retype is a local call, so the mod does not offer the Canal in a network game.
