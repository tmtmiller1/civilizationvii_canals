# Compatibility with other mods

Last reviewed 2026-10-15 against Canals 1.5.3 on Civilization VII 1.5.0. The review before it (2026-09-29) was against
Canals 1.1.0. What it said about code that has since gone is listed under "Retired since the 1.1.0 review" at the end,
and the one row it based on a game test is marked for a rerun.

This file records what Canals touches, which kinds of mod touch the same things, and what a player would see when both
are enabled. It comes from reading code rather than from playing: the 1,187 community mods in the reference corpus
(refreshed 2026-09-21), the mods installed on the development machine, and Tower's own mods. Each finding carries a
status line. "Read from code, not run" means it hasn't been tried in a game: treat it as a prediction with its
reasoning laid out. The cheapest test against the 1.5.x code that would settle it is named beside it.

Other authors' mods are described by what they do, not by name. The same mechanism usually appears in several mods,
and a player needs to recognise the kind of mod, not one title.

## What Canals touches

Everything a conflict could come through. A mod has to touch one of these to conflict with Canals.

| Surface | What Canals does with it |
| --- | --- |
| Database (game scope, LoadOrder 150/151) | Adds `BUILDING_CANAL_ANTIQUITY/EXPLORATION/MODERN` and the one-tile `BUILDING_CANAL_ONE_TILE` (Urban and Rural districts, `MultiplePerCity`, Town), their yields, one tech unlock row per age (Engineering, Shipbuilding, Industrialization, and Irrigation for the one-tile Canal in Antiquity), two site-marker features (`FEATURE_CANALS_SITE`, `FEATURE_CANALS_SITE_ONE_TILE`) that each Canal requires on its tile (`Constructible_RequiredFeatures`), yield rows that give a marked tile what the same land yields bare, an AI list that values each Canal at +3,000 (`Canals Site Priority`), icons and Civilopedia pages. Base rows are left as they are. |
| `Game.CityOperations` / `Game.CityCommands` | Wraps `canStart`, `canStartQuery` and `sendRequest` on both hosts. For a Canal the offered plots are the engine's own list for a plain building of the age (its urban tiles) plus the settlement's worked rural tiles and the bare tiles in its build ring, narrowed by the site rule. An order goes through `placeCanal`: a rural district for a bare tile, the site marker, the engine's own per-plot yes, earlier-age buildings taken off, then the order forwarded. For every other building it removes opened canal tiles from the plot list and refuses a request aimed at one. |
| `Game.UnitOperations.sendRequest` | Not wrapped since 1.5.2: the per-turn transit quota is off (`TRANSIT_LIMIT`). When on, wraps it to hold the local player's `MOVE_TO` orders to the quota, and never blocks on its own error. |
| `Network.saveGame` | Wraps it: canals are turned back to land on the map before any save is sent, and back to Coast on `SaveComplete`. |
| Autosave | While a canal is open, stores the player's autosave frequency as 1000 + their value (so the engine skips its own) and writes the autosave itself at the start of the player's turn. `ui/canals-shell.js` restores the value at the main menu. |
| Options screen | Wraps `Options.addOption` so the autosave slider shows the player's own value, and adds a "Canal rules" row to the shared Mods category in Options, Add-ons (`ui/canals-options.js`). |
| Map | `WorldBuilder.MapPlots.setTerrain` on each opened canal tile (land and Coast, as above); clears the tile's feature when the canal opens. `setFeature` places and lifts the site markers on AI sites, ordered and queued Canals and opened canals, and puts back the vegetation, wetland or floodplain a marker replaced. |
| Players' cities | Creates and destroys districts and constructibles (`CREATE_ELEMENT`, `DESTROY_ELEMENT`): a rural district for a bare tile before an order, earlier-age buildings taken off at an order and put back if its Canal never reaches the map, the fishing boat and the urban teardown at an opening, districts without a city rebuilt for their city. Also `purchasePlot`, `addRuralPopulation` and the city's `EXPAND` command for the canal's citizen, the build queue's `RemoveAt` and `MoveTo` to put an order back on a healed tile, and `grantYield` (gold) for a Canal the mod sells itself. |
| Saved game state | GameConfiguration keys `Canals_Pending_v1`, `Canals_Open_v1`, `Canals_Sites_v1`, `Canals_DistrictsChecked_v1`, `Canals_Told_*`, and `ModOptions_tower-canals` (the game's canal rules). |
| Shared settings | The `modSettings` localStorage entry Tower's other mods use, under `tower-canals` (the main menu's canal rules). |
| Globals | Sets `globalThis.__canals`; reads `globalThis.__towerNationalPark`. |

## Summary

| Kind of mod | Result | Status |
| --- | --- | --- |
| Gives every building a placement adjacency (ring or compact-city mods) | Sites away from the centre are offered, then refused when ordered; the tile is left as it was | Read from code, not run |
| National Park | Park land is left out of every Canal list and refused, in either load order | Tested on Canals 1.1.0 with a pre-release National Park; rerun owed on 1.5.x |
| Another script that restricts where buildings go | A rural tile it protects can be offered, then refused; an earlier-age building on an urban tile taken off for the order is put back when the refusal only comes as it's sent | Read from code and run against a fake engine, not in a game |
| Dams | Works together, except that an earlier-age Dam may be offered and destroyed | Read from code, not run; unconfirmed, lab check owed |
| Saves or archives games through `Network.saveGame` | Works; an archiving mod that saves from `SaveComplete` may, in one handler order, save canals as open sea | Read from code, not run |
| Changes the autosave frequency itself | None found; would fight over the setting | Read from code |
| Edits terrain or features during play | A canal tile edited away comes back as water; a site marker comes back at the next turn start | Read from code, not run |
| Replaces the production or purchase screen | Works if it builds its lists through the engine calls, which every one found does | Read from code; one price edge not run |
| Wraps `Options.addOption` or `UnitOperations.sendRequest` | Chains cleanly | Read from code |
| Rescales building costs or reshapes the tech tree | Canal arrives at a different time or price; the rest works as before | Read from code |
| Tower's Build Wonders Over Antiquated Buildings, Cultural Diffusion, Emigration, Geographic Labels, Demographics | No interaction found | Read from code |
| Two copies of Canals installed at once | Unpredictable | Known engine behaviour |

No type, text key, icon ID, GameConfiguration key, global or mod id in the corpus collided with Canals 1.1.0's names
(checked 2026-09-21). The names added since (`BUILDING_CANAL_ONE_TILE`, `FEATURE_CANALS_SITE`,
`FEATURE_CANALS_SITE_ONE_TILE`, the `Canals Site Priority` AI list, `Canals_Sites_v1`, `Canals_DistrictsChecked_v1`,
`ModOptions_tower-canals` and the `canals-mode` option id) haven't been checked against it: the corpus volume wasn't
mounted on 2026-10-15. Cheapest test: mount it and `grep -rlF` for each name.

## Findings

### 1. Mods that give every building a placement adjacency

Status: read from code, not run. Cheapest test against 1.5.x: enable Canals and such a mod, start an Exploration lab
game (seed 9001) with Shipbuilding granted, and read `__canals.eligiblePlots(<city id>, false, true)` for a city with a
worked or bare site two or more tiles from its centre. Then buy a Canal on that site and read the `[Canals]` lines in
`UI.log` and the tile afterwards.

Some mods confine buildings near the city centre by rewriting the database: one `UPDATE Constructibles SET
AdjacentDistrict = 'DISTRICT_CITY_CENTER' WHERE ConstructibleClass = 'BUILDING'` (with exceptions for walls and
full-tile buildings), run at a very high LoadOrder so it lands after every other mod. The Canal is a `BUILDING` with no
terrain rows, so the update catches it, and the engine then takes a Canal only on a tile touching the city centre.

What 1.5.x does with that, read from `ui/canals-placement.js`:

- The list. Urban tiles come from the engine's own list for a plain building of the age (`enginePlots`), and under such
  a mod that list holds only tiles beside the centre too. Worked rural tiles and bare tiles in the build ring are added
  without asking the engine (`inBuildReach`, called from `eligiblePlots`), so those further out are still offered.
- The order. `placeCanal` gives a bare tile a rural district, puts the site marker on, and waits up to two seconds for
  the engine's yes for that tile. The engine refuses (the tile isn't beside the centre), so the mod logs the refusal
  with the engine's answer, lifts the marker (the feature it replaced comes back) and takes off the district it made.
  The tile's own improvement stays: everything else in the order comes after the engine's yes.

What the player sees: a site further out is offered, the order goes nowhere and the tile looks as it did, with the
reason only in the log. Sites beside the centre work. Under 1.1.0 the tile was cleared first and could lose its
improvement.

What would fix the rest: asking the engine about every rural and bare tile won't do it, since the engine refuses a
Canal on any tile without its marker. A trigger like the one Dams ships (`dams/data/dams-placement.sql`), which clears
`AdjacentDistrict` on its own buildings whenever a later update sets it, would keep the Canal's rows out of such an
update. That's the owner's call: it overrides the other mod for Canals.

Under such a mod the engine applies the adjacency to the game's own AI as to the player, so an AI builds a Canal only
on a marked site beside one of its centres. Sites marked further out stay unused.

### 2. Other scripts that restrict where buildings go

Status: read from code, not run. Cheapest test against 1.5.x: with Canals and such a mod, in an Exploration lab game,
read the `Plots` of `Game.CityOperations.canStart(<city id>, CityOperationTypes.BUILD, { ConstructibleType: <the
Canal's index> }, false)` and see whether a rural tile the other mod protects is among them, in both load orders. Then
order a Canal there and read the log and the tile.

Several mods wrap the same `canStart` and `sendRequest` calls to keep buildings off certain tiles. Wrappers chain: each
calls the one it replaced, so every mod's rule is applied, and wrappers that only narrow the answer (fewer plots, a
refusal) combine in any order. Canals widens the answer for a Canal: the engine offers a Canal nowhere until a tile
holds its marker, so Canals builds the plot list itself.

- The other mod's script wraps after Canals': it filters Canals' list, and the combination is correct.
- It wraps before Canals': Canals' urban tiles come from the engine's list for a plain building through the call it
  saved, which is the other mod's wrapper, so a protected urban tile drops out if that mod keeps every building off it.
  Worked rural and bare tiles are added without that call, so a protected one can be offered. When it's ordered,
  `placeCanal` asks the same saved call about that tile; if the other mod refuses there, the order backs out as in
  finding 1 and the tile is left as it was.
- If the other mod refuses only in `sendRequest`, the order is forwarded, the Canal hasn't landed after three seconds,
  and `placeCanal` backs out: the marker lifted, a district it made taken off. An earlier-age building on an urban tile
  was taken off just before the order was forwarded; since 2026-10-16 it's made again on the tile as the order backs
  out (`notTaken`, `putBack`), and comes back finished, as a district's buildings do when one is healed (`hl2`).

National Park is handled directly (see 2a). The order of `placeCanal`, a watched sequence, stays as it was: the
buildings still come off before the order goes, and the put-back runs only once the order has failed. A Canal that
got into the queue and is taken out later leaves the old building gone, as the game's own overbuild does (it clears
the tile at queue time, `engine-closed.md`). Not watched in a game yet.

### 2a. National Park

Status: needs a rerun. Tested in game on 2026-09-29 against Canals 1.1.0 and a pre-release National Park, both wrap
orders, with a control run on 1.1.0 (harness `mod_ideas_tested/canals/devtools/harness/canalh-game-np1.js`, runs
`np1-fix`, `np1-control`, `np2-reverse`, Modern Age, seed 9001; offline test of the same wrappers:
`mod_ideas_tested/canals/devtools/np-order-test.mjs`). Both mods have changed since, and the harness drives 1.1.0's
hooks.

What 1.5.x does, read from code: Canals asks National Park for its park tiles at the moment it builds a list or judges
a site (`globalThis.__towerNationalPark.parks()`, `isParkland`), so load order doesn't matter. Park land is left out of
every Canal list, a Canal on it is refused with "A Canal cannot be dug through a National Park.", and an order for it
is passed on untouched, so the tile isn't prepared. 1.5.x adds a second guard: the engine takes a Canal only on a
marked tile, and the AI's sites come from the same list, so park land isn't marked for an AI.

What has changed since the test:

- A queued Canal sits on a rural district now (the worked tile's own, or one the mod made on a bare tile), where 1.1.0
  made an urban one. National Park takes a rural tile but not one holding a building (`joinable` in
  `national_parks/ui/np-core.js`), so whether a queued Canal's tile can join a park depends on whether the unfinished
  Canal is on the map yet. A production order reaches the map at once or a little later (`s1`, `cm2`).
- The AI planner of 1.1.0, whose canal under way was abandoned when its tile became park land, went in 1.2.0. An AI's
  queued Canal keeps its marker until the order is done with (`queuedCanalOrders`), and `openCanal` doesn't ask about
  park land.

What the 1.1.0 test found, for the record: with the fix, in both wrap orders, the park tile was left out of every list,
both per-plot checks refused it, and a purchase and a build sent at it left the tile, the park and the gold as they
were. The 1.1.0 control with Canals last dug a canal through the park. The other direction held too: a park wasn't
offered an opened canal tile, and a park aimed at it was refused ("Nothing else can be built on a canal").

The rerun, in both orders (National Park wraps last by default, its LoadOrder 9999 against Canals' 150):

1. Before a park, the isthmus is in the production and purchase lists. After a park takes it, it's left out of every
   Canal list and of `__canals.aiSites()`, both per-plot checks refuse it with `LOC_CANAL_PARKLAND`, and a purchase and a build
   sent at it leave the marker, district, owner, park record and gold as they were.
2. An opened canal isn't offered to a park's expansion, and a park aimed at it is refused.
3. New in 1.5.x: a Canal queued through production on a bare tile, then that tile offered to a park, once before the
   Canal reaches the map and once after. Record whether National Park takes it, and what happens to the queued Canal and
   its marker at the next turn start.
4. A Canal on a free isthmus still opens with both mods loaded.

### 3. Dams

Status: read from code, not run together. The earlier-age Dam below is unconfirmed; lab check owed. Cheapest test
against 1.5.x: in an Exploration lab game with Dams and Canals, put an Antiquity Dam on an urban district on a
minor-river tile beside the coast, within three tiles of the city centre, and read
`__canals.eligiblePlots(<city id>, false, true)` and `__canals.eligiblePlots(<city id>, false, false)`. The Dam's plot
in either list means a Canal is offered on it. Leave the Canal unordered in that check.

Dams 2.0.3 places Dams by its data alone (`RiverPlacement="RIVER"` on an urban district) and doesn't wrap any of the
placement calls, so Canals' wrappers are the only ones in play.

- A Dam on an opened canal: Canals takes canal tiles out of every other building's lists and refuses a request aimed at
  one ("Nothing else can be built on a canal."), so the player can't build one there. An AI's buildings go through the
  engine alone; whether the engine would put an AI's Dam on a canal tile (Coast, a rural district holding the Canal)
  hasn't been read or run.
- A Canal on a tile holding a Dam of the age being played: a building of the age keeps its tile (`eligiblePlots`), so
  the Canal isn't offered there.
- A Canal on a tile holding an earlier-age Dam: was offered, fixed after 1.5.3. `isObsolete` treated any building of an
  earlier age without the `AGELESS` tag as one the Canal replaces, and `BUILDING_DAM_ANTIQUITY` has no `AGELESS` tag
  (only the Levees carry it), so in Exploration an Antiquity Dam's tile could be offered and `placeCanal` would take the
  Dam off. The same read found the `AGELESS` check itself always false: `hasTag` called `GameInfo.TypeTags.some`, and
  GameInfo tables have no `some` (lab, 2026-10-15: `typeof GameInfo.TypeTags.some` is `undefined`), so every ageless
  building of an earlier age was replaceable too. In the same lab game an Odeon put on an offered site at 60,24 stayed
  offered under 1.5.2. Now `hasTag` reads the tags with `for...of` once, and `isObsolete` keeps every `BUILDING_DAM_`
  type. The fixed functions, run against the live tables in that game, count 0 of the 55 earlier-age ageless
  constructibles as replaceable (1.5.2: all 55), keep the Odeon tile and the Antiquity Dam, and still replace a Library.
  `tests/canal-rules.test.mjs` covers it. Not watched: the fixed build loaded through the game's own load path (two
  copies of Canals were enabled, so the bench wouldn't deploy), and an actual Dam on a candidate tile.
- Rivers: Dams indexes rivers from `MapRivers` when the game loads. Whether a canal cut across a minor river stays in
  that river's plot list after the retype hasn't been checked; the settlement that owns the canal should count as on
  that river for Levees either way, and a player shouldn't see any difference.
- Markers: Canals' site marker can replace a Dams 1.3.0 site marker (`clearableFeature` treats it as a marker). Dams
  2.x lifts those markers from old saves anyway.

### 4. Mods that save or archive games

Status: read from code, not run. Cheapest test against 1.5.x: enable a save-archiving mod (one that copies every Nth
autosave on `SaveComplete`), open a canal in a lab game, play two turns, then search `UI.log` for "save started with a
canal still Coast" and load the archived save to see whether the canal is drawn through land.

A save made while a canal is Coast reloads with the canal drawn as open sea, so Canals turns canals to land before
every save. It does this by wrapping `Network.saveGame`, which every save goes through, including saves other mods
make. The corpus has mods that archive a copy of every Nth autosave on `SaveComplete`, and save-screen replacements
that call `Network.saveGame` for quicksaves; all of them call the global at the moment of saving, so they get the
wrapped call and their saves hold canals as land.

The case to watch is an archiving mod that saves from inside `SaveComplete`, where the outcome depends on which
`SaveComplete` handler runs first. If Canals' runs first, the canals turn back to Coast, the archiving save comes
through the wrapped call, and Canals turns them to land again before sending it. If the archiving mod's runs first,
Canals still counts the first save as running and passes the second straight on, then its own handler turns the canals
to Coast while that second save is starting. The archived copy would then reload its canals as open sea, and a retype
that meets a save being written is what crashed run `c71`. The test above shows which order the game uses.

Canals' own autosaves are written with the autosave category, so a mod that counts autosaves sees them.

A mod that captured `Network.saveGame` into a variable before Canals loaded would bypass the wrapper, and its saves
would reload canals as open sea. None in the corpus does.

### 5. Mods that change the autosave frequency

Status: read from code. None found in the corpus.

While a canal is open, Canals holds the engine's autosave by storing the frequency as 1000 plus the player's value,
and re-applies that at every turn change. A mod that also sets the frequency would be overwritten each turn, and its
value would be read by Canals as the player's own. If such a mod appears, the fix is to agree on reading the frequency
modulo 1000.

### 6. Mods that edit terrain or features during play

Status: read from code, not run. Cheapest test against 1.5.x: in a lab game with a canal open, stand in for an editor
from the console with `WorldBuilder.MapPlots.setTerrain(<TERRAIN_FLAT index>, {x, y})` on the canal tile and
`WorldBuilder.MapPlots.setFeature(FeatureTypes.NO_FEATURE, {x, y})` on an AI's marked site, end the turn, and at the
next turn start read both tiles and the `[Canals]` lines ("canal tile(s) back to Coast", "sites: ... marked").

Sandbox and cheat panels, in-game map editors, and a few custom leader abilities call
`WorldBuilder.MapPlots.setTerrain` or `setFeature` mid-game. Canals keeps its own record of every opened canal and of
every site it marked, and acts on those records at each save, load and turn start. Consequences:

- A canal tile turned into land with an editor comes back as water at the next turn start.
- A tile beside a canal turned into land or water changes the channel drawing only after the next load, and can leave
  the canal cut off from the water. Canals doesn't hold an open canal to the site rule again.
- An editor that removes a whole canal can't remove its record; only removing the mod does.
- A site marker an editor takes off comes back at the next turn start while the tile is still a site (an AI's
  worthwhile site, a queued Canal or an opened canal). Until then the engine won't place a Canal there.
- Canals puts its marker only over vegetation, wetland, floodplain or bare land. Another mod's feature of any other
  kind stays where it is, and that tile can't take a Canal while it does.

None of this can corrupt a save. It explains why a canal "refuses" to be edited.

### 7. Production and purchase screen replacements

Status: read from code. In the 1.1.0 review the one installed on the development machine was read in full and the rest
by search; the price edge below is read from code, not run.

The Canal row reaches the list because Canals rewrites the answer of `canStartQuery`, which is what the base
production and purchase lists are built from; in a town the engine gives no Canal row at all and Canals adds one.
Every replacement screen found in the corpus (compact production lists, city-detail panels, queue helpers) builds its
lists by calling `Game.CityOperations.canStartQuery` / `Game.CityCommands.canStartQuery` and `canStart` at the time it
draws, so it receives Canals' answer. 1.5.x hasn't changed that.

One edge: in a game Canals was added to after the Canal's tech was researched, the mod sells the Canal for gold and
reports its own price in the result's `Cost`, greying it with `InsufficientFunds` when the player is short. A
replacement screen that computes the price itself, rather than reading the result, may show a different number or mark
the row differently. Cheapest test against 1.5.x: load a save Canals was added to after Engineering (`AugustusAnt99`,
as in `c101b`) with the installed screen replacement on, and compare the Canal row's price with the `Cost` from
`Game.CityCommands.canStart(<town id>, CityCommandTypes.PURCHASE, { ConstructibleType: <the Ancient Canal's index> },
false)`.

### 8. Other wrappers of the same hooks

Status: read from code.

- `Options.addOption`: another mod in the corpus wraps it to extend a different option. Both wrappers call the one they
  replaced and act on different option ids. Canals' own "Canal rules" row goes in through `Options.addInitCallback`, in
  the shared Mods category, which it creates only when it's missing, as Tower's other mods and the community's do.
- `Game.UnitOperations.sendRequest`: a balance mod wraps it to react to one unit ability. Canals leaves it alone while
  the ship limit is off; with `TRANSIT_LIMIT` on, both call through and Canals' wrapper never throws into the chain.

Canals' `uninstall()` (a development hook, never called in play) puts back the functions it saved. If another mod
wrapped after Canals, that also removes the other mod's wrapper until reload.

### 9. Cost and tech-tree mods

Status: read from code.

Mods that multiply building costs apply after Canals loads (LoadOrder 500 against 150), so the Canal's price changes
with them, for the player and for the game's AI, which builds the Canal like any building. A Canal the mod sells itself
is priced from the engine's own purchase cost, which follows the scaled row. Tech-tree mods in the corpus move
prerequisites and costs of Engineering, Shipbuilding and Industrialization and every one keeps those nodes and the Canal
unlock rows, so the Canal only arrives earlier or later. Irrigation, which unlocks the one-tile Canal in Antiquity since
1.4.0, wasn't part of that read.

### 10. Tower's other mods

Status: read from code.

| Mod | Interaction |
| --- | --- |
| Build Wonders Over Antiquated Buildings | Offers only urban tiles whose buildings are all from an earlier age. An opened canal sits on a rural district, so it's left out, and Canals also refuses a Wonder on a canal tile. Since 1.5.0 Canals offers the same kind of urban tile. Read 2026-10-15, both script orders: they don't meet. A Canal order removes the old buildings as it's placed, so the tile is empty to Build Wonders until the Canal shows, and then it holds a building of the age; a Wonder turns the tile into a Wonder district at once, which Canals never offers. Two things are left to watch: before a production Canal shows on the map, only opened canals are kept off other buildings' lists, so the game itself could offer the tile; and a Canal left unfinished into the next age would read as antiquated to Build Wonders. The first was watched 2026-10-15 (`verification-runs.md`, `ow7`): in the window a Wonder isn't offered the tile but an ordinary building is, and a Bazaar bought there kept the finished Canal from opening ("left as a building"). The second isn't watched. |
| Cultural Diffusion | Its culture field covers land tiles, and a canal is Coast during play, so the pass doesn't diffuse through it. Claims inside a city's base ring are left to the base game, which is where every canal is. |
| Emigration | No shared hook. A canal's citizen is placed by the city's own expand order and counts like any other. |
| Geographic Labels | Scans the map at load, while canals are still land (Canals waits until the game has started to turn them to Coast). A canal tile keeps its land area id either way, so labels aren't affected. |
| Demographics, History & Rankings | Read yields and constructibles. The Canal building's yields count as any building's. |
| National Park, Dams | See 2a and 3. |

### 11. Two copies of Canals

Status: known behaviour of the game.

A Workshop subscription and a manually installed copy both declare `tower-canals`. The game may load either one, and a
stale copy can shadow a newer one. Keep one copy: unsubscribe or delete the folder.

## Retired since the 1.1.0 review

These came from code that's gone, so their cheapest tests are dropped.

- The `BuildQueue.addProgress` (negative) entry under "Players' cities", the AI production drained into a Canal each
  turn (old finding 3), and the AI canal project's cost read from the Canal's row (old finding 9). They all belonged to
  the AI planner that dug AI canals itself. It went in 1.2.0; the game's own AI builds a Canal on a marked site like any
  building, and `addProgress` isn't in `canals.js` any more.
- The GameConfiguration key `Canals_AI_v2`, the same planner's record.
- The prediction in old findings 1 and 2 that a refused Canal leaves its tile cleared, after an urban district, a
  five-second wait and a rollback. 1.5.0's `placeCanal` waits for the engine's own per-plot yes before it touches the
  tile, apart from a bare tile's rural district, which it takes off again on a refusal.
- Old finding 1's note that AI canals go through `CREATE_ELEMENT` for the Canal: the AI's canals have been its own
  builds since 1.2.0.
- Old 2a's "a queued Canal's urban district bars the tile from a park": a queued Canal sits on a rural district since
  1.5.0 (see 2a).
