# Compatibility with other mods

Last reviewed 2026-09-29 against Canals 1.1.0 on Civilization VII 1.5.0.

This file records what Canals touches, which kinds of mod touch the same things, and what a player would see when
both are enabled. It comes from reading code rather than from playing: the 1,187 community mods in the reference
corpus (refreshed 2026-09-21), the mods installed on the development machine, and Tower's own mods. Each finding
carries a status line. "Read from code" means it has not been tried in a game; treat it as a prediction with its
reasoning laid out, and the cheapest test that would settle it is named beside it.

Other authors' mods are described by what they do, not by name. The same mechanism usually appears in several mods,
and a player needs to recognise the kind of mod, not one title.

## What Canals touches

Everything a conflict could come through. If another mod touches none of these, it cannot conflict with Canals.

| Surface | What Canals does with it |
| --- | --- |
| Database (game scope, LoadOrder 150/151) | Adds `BUILDING_CANAL_ANTIQUITY/EXPLORATION/MODERN` (Urban and Rural districts, `MultiplePerCity`, Town), their yields, one tech unlock row per age (Engineering, Shipbuilding, Industrialization), icons. Changes no base row. |
| `Game.CityOperations` / `Game.CityCommands` | Wraps `canStart`, `canStartQuery` and `sendRequest` on both hosts. For a Canal it replaces the engine's plot list with its own isthmus sites. For every other building it removes opened canal tiles from the plot list and refuses a request aimed at one. |
| `Game.UnitOperations.sendRequest` | Wraps it to hold the local player's `MOVE_TO` orders to the per-turn transit quota. Never blocks on its own error. |
| `Network.saveGame` | Wraps it: canals are turned back to land on the map before any save is sent, and back to Coast on `SaveComplete`. |
| Autosave | While a canal is open, stores the player's autosave frequency as 1000 + their value (so the engine writes none) and writes the autosave itself at the start of the player's turn. `ui/canals-shell.js` restores the value at the main menu. |
| Options screen | Wraps `Options.addOption` so the autosave slider shows the player's own value. |
| Map | `WorldBuilder.MapPlots.setTerrain` on each opened canal tile (land and Coast, as above); clears the tile's feature when the canal opens. |
| Players' cities | Creates and destroys districts and constructibles (`CREATE_ELEMENT`, `DESTROY_ELEMENT`), `purchasePlot`, `addRuralPopulation`, `grantYield` (gold), and for an AI's canal `BuildQueue.addProgress` (negative). |
| Saved game state | GameConfiguration keys `Canals_Pending_v1`, `Canals_Open_v1`, `Canals_AI_v2`, `Canals_Told_*`. |
| Globals | `globalThis.__canals`. |

## Summary

| Kind of mod | Result | Status |
| --- | --- | --- |
| Gives every building a placement adjacency (ring or compact-city mods) | Canal offered, then refused; the tile can lose its improvement | Read from code |
| National Park | Works together in either load order: park land is never a Canal site | Tested in game, both orders |
| Another script that restricts where buildings go | Depends on which script wraps last | Read from code |
| Dams | Works together | Read from code |
| Saves or archives games through `Network.saveGame` | Works; those saves hold canals as land like any other | Read from code |
| Changes the autosave frequency itself | None found; would fight over the setting | Read from code |
| Edits terrain during play (sandbox panels, map editors, some leader abilities) | A canal tile edited away comes back as water | Read from code |
| Replaces the production or purchase screen | Works if it builds its lists through the engine calls, which every one found does | Read from code |
| Wraps `Options.addOption` or `UnitOperations.sendRequest` | Chains cleanly | Read from code |
| Rescales building costs or reshapes the tech tree | Canal arrives at a different time or price; nothing breaks | Read from code |
| Tower's Build Wonders Over Antiquated Buildings, Cultural Diffusion, Emigration, Geographic Labels, Demographics | No interaction found | Read from code |
| Two copies of Canals installed at once | Unpredictable | Known engine behaviour |

No type, text key, icon ID, GameConfiguration key, global or mod id in the corpus collides with Canals'.

## Findings

### 1. Mods that give every building a placement adjacency

Status: read from code, not run. Cheapest test: enable Canals and such a mod, start an Antiquity game with
Engineering granted, order a Canal on a site two or more tiles from the city centre, and read the tile and
`[Canals]` lines in `UI.log`.

Some mods confine buildings near the city centre by rewriting the database: one `UPDATE Constructibles SET
AdjacentDistrict = 'DISTRICT_CITY_CENTER' WHERE ConstructibleClass = 'BUILDING'` (with exceptions for walls and
full-tile buildings), run at a very high LoadOrder so it lands after every other mod. The Canal is a
`BUILDING` with no terrain rows, so the update catches it, and the engine will then accept a Canal only on a tile
touching the city centre.

Canals narrows the engine's own list to its canal sites and adds the worked and bare tiles the engine takes a Canal on. So the player is still shown
sites anywhere in the city's reach. When one is chosen:

1. The mod clears whatever stood on the tile (a farm, fishing boats) and creates an urban district there.
2. It waits up to five seconds for the engine to accept the Canal on that tile, sends the build anyway, and watches
   for six seconds.
3. The engine refuses (the tile is not beside the centre), so the mod removes the district and buys the plot back.

What the player sees: the Canal is not queued, the tile's improvement is gone and is not put back, and nothing on
screen says why (the reason is only in the log). Sites next to the city centre still work.

What would fix it: on the Canals side, read the engine's per-plot verdict before clearing the tile, and offer only
sites the engine would accept, so the list itself shrinks under such a mod. The rollback could also put back the
improvement it removed. Until then the player-side workaround is to disable one of the two, or to build Canals
only beside the city centre.

The AI's canals take a different path (`CREATE_ELEMENT` for the Canal itself), and whether the engine applies the
adjacency rule to that call is not known.

### 2. Other scripts that restrict where buildings go

Status: read from code, not run. Cheapest test: with Canals and such a mod both enabled, open a Canal list in a
city that has a tile the other mod protects on an isthmus, and see whether that tile is offered.

Several mods wrap the same `canStart` and `sendRequest` calls to keep buildings off certain tiles. Wrappers chain:
each one calls the one it replaced, so every mod's rule is applied. The order matters only in one direction, and
Canals is the reason:

- Most wrappers only narrow the engine's answer (fewer plots, a refusal). Any number of those combine in any order.
- Canals widens the answer for a Canal: the engine offers no plots for it (it needs an urban district the tile
  does not have yet), so Canals replaces the plot list with its own sites and answers "yes" for a site.

If the restricting mod's script runs after Canals', it filters Canals' list and the combination is correct. If it
runs before, Canals replaces its filtered list, and a tile that mod protects is offered for a Canal. The build then
reaches the other mod's `sendRequest` wrapper, which refuses it, and the player gets the result described in
finding 1: tile cleared, no Canal.

National Park is handled directly (see finding 2a). For any other such mod, what would fix it on the Canals side:
filter its own site list through the wrapped per-plot check of the call it replaced, so an inner mod's refusal is
respected whichever order the scripts load in. That needs a probe first: the engine refuses a Canal on every
rural tile anyway, and its refusal has to be told apart from the other mod's.

### 2a. National Park

Status: tested in game on 1.5.0, 2026-09-29, both wrap orders, with a control run on 1.1.0. Harness:
`mod_ideas_tested/canals/devtools/harness/canalh-game-np1.js` (runs `np1-fix`, `np1-control`, `np2-reverse`; Modern
Age, seed 9001). Offline test of the same wrappers: `mod_ideas_tested/canals/devtools/np-order-test.mjs`.

Canals asks National Park for its park tiles at the moment it builds a list or judges a site
(`globalThis.__towerNationalPark.parks()`), so load order no longer matters. Park land is left out of the Canal
list, a Canal on it is refused with "A Canal cannot be dug through a National Park.", a build request for it is
passed on untouched (nothing is cleared), and an AI's Canal under way on a tile that becomes park land is
abandoned.

How the game test ran: a city beside a natural wonder and an isthmus; Natural History completed; a real park bought
through the city's purchase list on the tile beside the wonder; an expansion bought and the isthmus taken through
National Park's picker (its farm stripped, a park marker placed). Then, in each order, the Canal lists
(production, purchase, the list query, the AI's site choice), the per-plot verdicts, the purchase screen, and a
purchase and a build sent at the park tile.

- National Park wraps last by default (its LoadOrder 9999 against Canals' 150): all four calls were National
  Park's outermost wrapper in every run. The other order was made in game by taking both mods down and putting
  them back with Canals last.
- With the fix, both orders: before the park, the isthmus is offered and the Canal row is in the purchase list;
  after it, the row is gone, every list leaves the tile out, the AI does not pick it, both per-plot verdicts refuse
  it, and a purchase and a build sent at it change nothing (marker, district, owner, park record, gold).
- 1.1.0 control, National Park last: the player sees the same as with the fix (no row, refused, nothing changed);
  only Canals' own site list still held the tile. Canals last: the Canal row came back in the purchase list with
  the park tile as its site, the purchase went through, and the Canal was dug through the park (the park marker
  replaced by the Canal and a fishing boat, the tile dropped from the park). The AI's site choice also picked the
  park's founding tile. So the failure in that order was worse than predicted above: not a cleared tile, but a
  canal through the park.
- A Canal on a free isthmus still opens with both mods loaded (bought, charged once, Coast).

The other direction needed no change, and was tested: with a canal already open on the isthmus, a park founded
beside it was not offered the canal tile, a park aimed at it is refused ("Nothing else can be built on a canal"),
and the park's expansion list left it out. The Canal building bars the tile from joining a park, and a queued
Canal's urban district does the same. Not tested: a click on the canal tile inside the open picker (the list the
picker lights was read instead).

### 3. Dams

Status: read from code, not run together.

Both mods wrap the same placement calls. Dams only narrows (one Dam per river per age, and only for Dam types), and
Canals narrows for every non-Canal building on an opened canal, so the two work in either order.

- A Dam cannot be built on an opened canal: Canals refuses every other building there.
- A Canal cannot be started on a tile that holds a Dam: Canals never offers a tile holding buildings.
- A canal cut across a tile of a minor river keeps that tile in the river's plot list (Dams reads rivers once, from
  `MapRivers`, when the game loads), so the settlement that owns the canal still counts as being on that river for
  Levees. No player-visible effect is expected.
- An AI city building a Canal has its production drained into the Canal each turn, whatever it was building, a Dam
  included. This is how every AI canal is paid for, not a Dams-specific effect.

### 4. Mods that save or archive games

Status: read from code, not run. Cheapest test: enable a save-archiving mod, open a canal, play two turns, load the
archived save, and look at the canal.

A save made while a canal is Coast reloads with the canal drawn as open sea, so Canals turns canals to land before
every save. It does this by wrapping `Network.saveGame`, which every save goes through, including saves other mods
make. The corpus has mods that archive a copy of every Nth autosave on `SaveComplete`, and save-screen replacements
that call `Network.saveGame` for quicksaves; all of them call the global at the moment of saving, so they get the
wrapped call and their saves hold canals as land. When an archiving mod starts its save from the same
`SaveComplete` that turns canals back to Coast, Canals turns them to land again for the second save; the guard that
keeps a retype from running during a save (the cause of the crash in run `c71`) covers that sequence.

Canals' own autosaves are written with the autosave category, so a mod that counts autosaves sees them.

A mod that captured `Network.saveGame` into a variable before Canals loaded would bypass the wrapper and its saves
would reload canals as open sea. None in the corpus does.

### 5. Mods that change the autosave frequency

Status: read from code. None found in the corpus.

While a canal is open, Canals holds the engine's autosave by storing the frequency as 1000 plus the player's value,
and re-applies that at every turn change. A mod that also sets the frequency would be overwritten each turn, and
its value would be read by Canals as the player's own. If such a mod appears, the fix is to agree on reading the
frequency modulo 1000.

### 6. Mods that edit terrain during play

Status: read from code, not run.

Sandbox and cheat panels, in-game map editors, and a few custom leader abilities call
`WorldBuilder.MapPlots.setTerrain` or `setFeature` mid-game. Canals keeps its own record of every opened canal and
retypes those tiles itself at each save and after it. Consequences:

- Turning a canal tile into land with an editor does not close the canal: at the next Coast pass Canals retypes it
  back to water.
- Turning a tile beside a canal into land or water changes the channel drawing only after the next load, and can
  leave the canal joining nothing. Canals does not re-check that a site still joins two bodies of water once it is
  open.
- An editor that removes a whole canal cannot remove its record; only removing the mod does.

None of this can corrupt a save. It explains why a canal "refuses" to be edited.

### 7. Production and purchase screen replacements

Status: read from code; the one installed on the development machine was read in full, the rest by search.

The Canal row reaches the list because Canals rewrites the answer of `canStartQuery`, which is what the base
production and purchase lists are built from; in a town the engine gives no Canal row at all and Canals adds one.
Every replacement screen found in the corpus (compact production lists, city-detail panels, queue helpers) builds
its lists by calling `Game.CityOperations.canStartQuery` / `Game.CityCommands.canStartQuery` and `canStart` at the
time it draws, so it receives Canals' answer.

One untested edge: in a game where Canals was added after the Canal's tech was researched, the mod sells the Canal
for gold and reports its own price in the result's `Cost`. A replacement screen that computes the price itself,
rather than reading the result, may show a different number or mark the row too expensive.

### 8. Other wrappers of the same hooks

Status: read from code.

- `Options.addOption`: another mod in the corpus wraps it to extend a different option. Both wrappers call the one
  they replaced and act on different option ids.
- `Game.UnitOperations.sendRequest`: a balance mod wraps it to react to one unit ability. Both call through, and
  Canals' wrapper never throws into the chain.

Canals' `uninstall()` (a development hook, never called in play) puts back the functions it saved. If another mod
wrapped after Canals, that also removes the other mod's wrapper until reload.

### 9. Cost and tech-tree mods

Status: read from code.

Mods that multiply building costs apply after Canals loads (LoadOrder 500 against 150), so the Canal's price
changes with them. The AI's canal project reads its cost from the same row, so it pays the scaled price. Tech-tree
mods in the corpus move prerequisites and costs of Engineering, Shipbuilding and Industrialization but none deletes
those nodes or the Canal unlock rows, so the Canal only arrives earlier or later.

### 10. Tower's other mods

Status: read from code.

| Mod | Interaction |
| --- | --- |
| Build Wonders Over Antiquated Buildings | Offers only urban tiles whose buildings are all from an earlier age. An opened canal sits on a rural district, so it is never offered; Canals also refuses a Wonder on a canal tile. |
| Cultural Diffusion | Its culture field covers land tiles, and a canal is Coast during play, so the pass does not diffuse through it. Claims inside a city's base ring are left to the base game, which is where every canal is. |
| Emigration | No shared hook. A canal's citizen is placed by the city's own expand order and counts like any other. |
| Geographic Labels | Scans the map at load, while canals are still land (Canals waits until the game has started to turn them to Coast). A canal tile keeps its land area id either way, so labels are not affected. |
| Demographics, History & Rankings | Read yields and constructibles. The Canal building's yields count as any building's. |

### 11. Two copies of Canals

Status: known behaviour of the game.

A Workshop subscription and a manually installed copy both declare `tower-canals`. The game may load either one,
and a stale copy can shadow a newer one. Keep one copy: unsubscribe or delete the folder.
