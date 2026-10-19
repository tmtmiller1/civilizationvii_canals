# What I tried

Every route I tried for Canals, including the ones that shipped, grouped by the question each one answers. Each row
says what I did, what the game did back, and where it ended: shipped (and in which version), replaced (by what),
closed (why), or still unwatched or unsettled. Run ids in backticks point at
[docs/verification-runs.md](docs/verification-runs.md) for the shipped mod; the June and September probes before it
live in the author's working tree under
`mod_ideas_tested/canals`. Everything was watched on Civilization VII 1.5.0 unless a row says it was read from code.

## Where to look

- [What a mod can and can't do to the map](#what-a-mod-can-and-cant-do-to-the-map)
- [Letting ships through](#letting-ships-through), including why the canal isn't a navigable river
- [Getting the Canal ordered and built](#getting-the-canal-ordered-and-built)
- [Letting the AI dig canals](#letting-the-ai-dig-canals)
- [Yields, the citizen, and a district slot](#yields-the-citizen-and-a-district-slot)
- [Drawing the canal](#drawing-the-canal)
- [Saves, reloads and age changes](#saves-reloads-and-age-changes)
- [Still unwatched or unsettled](#still-unwatched-or-unsettled)

## What a mod can and can't do to the map

The game runs mod scripts in its UI script engine. The gameplay side, where the map is built and the age transition
runs, is a separate engine that mods can only reach at map generation and at the age transition, never during a turn.

From the UI side a mod can retype a tile's terrain (the same call the game's Tuner uses), place and remove features,
buildings and districts, and draw the game's own models on the map. It can't rebuild the map's water areas, write a
river, move a unit without a path, clear a resource, or make the renderer redraw a hex it has already drawn.

A ship may enter a tile whose terrain is in the game's embarkation table: Coast, Ocean and Navigable River. Coast and
Ocean carry the terrain's own water flag, which the pathfinder reads straight from the tile. A navigable river is a
separate river record with its own flow, and the Navigable River terrain is only the paint on top of it.

## Letting ships through

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| Retype the tile to Navigable River | `setTerrain` to `TERRAIN_NAVIGABLE_RIVER` from a probe, with and without the matching floodplain feature, inside and outside a commit block | The terrain reads as Navigable River a tick later. The tile isn't water, isn't a navigable river to the river reads, a ship beside it gets a zero-plot path and sails around it. The same after a save and cold reload, where it draws as a shallow water hex (`c67`, `c68`) | Closed, June 2026; re-closed 2026-09-28 |
| Find a call that rebuilds the water data | Dumped every global the UI side exposes and tried about fifty likely hidden names on the map, builder, unit and game objects; ran the one region recalculation that exists | Nothing rebuilds navigation. The region call runs and changes nothing. The builder library the game's own map scripts use is undefined on the UI side | Closed, June 2026 |
| A new terrain type for the canal, in the embarkation table | Added a `Terrains` row and its type, alone and with the dependent rows | The database took it and the main menu came up; loading any save then crashed while the map loaded, every time (`c82`, `c84`) | Closed, 2026-09-28. The game only works with the terrains it ships with |
| Put a shipped land terrain in the embarkation table | Read from the table and the game's own Ocean Travel effect | It would make every tile of that terrain sailable, map-wide; it can't target one plot | Closed by reading |
| The bridge and route tags, or the river "ferry" | Read from the game's data and UI | Bridges and routes are land over river, fixed in the engine; the ferry is where a land unit crosses a river | Closed by reading |
| A gameplay-side script that makes the canal a river at load | A `ScenarioScripts` entry in the modinfo | The script never ran on a save load (`c85`) | Closed, 2026-09-28 |
| Let the next age's water rebuild pick the tile up | The June theory: a persisted retype becomes real water when the next age rebuilds its water data. Autoplayed an Exploration game with an open canal into Modern | The transition carries the old map's terrain across; the canal came in with its land area id after the new age's rebuild (`c100`) | Closed, 2026-09-28. The mod now lands the canals at the age end and opens them again once the new age loads |
| Write the river at the age transition | Read from the game's shipped transition script, which runs in the gameplay engine with the map builder in scope | A mod's own age-transition script could turn each canal of the ending age into a real navigable river for the next age | Closed, not built. From the player's side it doesn't work: the canal you dig behaves one way for the whole age you dug it in, then turns into something else at the age change, and a Modern canal never changes at all. Two kinds of canal on one map, with the difference set by when you built it |
| A "Use Canal" button that teleports the ship | The unit teleport call from a probe, armed at one tile and fired from another | The unit stayed where it was, no error. The only move without a path is destroy and create, which loses health, experience, promotions and identity, and the AI would never use it | Closed, June 2026 |
| Retype the tile to Coast | `setTerrain` to `TERRAIN_COAST` on a flat tile between two seas, a ship beside it | A path through the tile in the same turn, a real move landed the ship on the far side in the other sea (`c1`, `c4`). A ship also steps between a navigable river tile and the retyped tile, both ways (`c9`). The retype survives a cold reload; the tile's area id stays land, which is why the site rule reads a canal's waters from its neighbours (`c3`) | Shipped, 1.0.0 |
| Retype a cliff tile | The same on a tile with cliff edges | The retype clears every cliff flag, so ships cross every edge; the cliff rock stays drawn until the next load (`c21`) | Shipped, 1.0.0: cliffs allowed, locks drawn there |

## Getting the Canal ordered and built

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| A placement rule in the game's data | Read the requirement tables | They can't express "a land tile beside water a ship can sail", and the AI builds only what the data allows | Closed by reading. The mod wraps the placement queries and, for the AI, marks sites (below) |
| The map's own constructible placer | `WorldBuilder.MapConstructibles.addConstructible` in twelve call shapes | Places nothing | Closed, 2026-07-13 |
| Charge the cost ourselves and place the finished Canal | The mod takes the gold and creates the building on the retyped tile | Works in 69 ms, but the player builds nothing through the production screen (`c3`, `c4`) | Replaced by the real build path before 1.0.0. Kept for one case: a game the mod was added to after the Canal's tech, where the engine keeps the Canal locked (`c101`, 1.1.0) |
| A script-made urban district, then the engine's BUILD | The engine offers buildings only on urban tiles (`c7`), so the mod created one on the site, queued the Canal, and took the district down on completion | Works, but the district draws a block of houses over the site for several seconds and can leave empty houses when the order is refused. A district made without its city crashed the game the first time an AI built on it (1.2.2) and left broken quarters (1.3.1) | Shipped 1.0.0, replaced in 1.5.0 by the rural district below |
| The engine's BUILD on a rural district | A bare tile gets a rural district held by the city; the Canal is offered on worked tiles, bare tiles and urban tiles with only older buildings | The engine takes the Canal on a rural district in a city or a town, no houses ever appear (`cs1`, `cs2`, `cm1`, `cm2`, `wm1` to `wm6`) | Shipped, 1.5.0 |
| How far out the engine takes an order | Districts 2 and 12 plots from the centre | 12 plots out is refused however long you wait; 2 is taken (`c8b` to `c8g`) | Shipped: sites within the build ring |
| Towns | The purchase path, which the mod hadn't wrapped | A town's purchase list offered plain expansion tiles and refused the site; a bought Canal arrives complete with no completion event (`c36`) | Shipped 1.1.0: the purchase path wrapped, a bought Canal opened by the mod at once (`c37`) |
| The Canal row missing from a town's list | Read where the list comes from | The list is built from a second query the mod hadn't wrapped, and a failing entry is hidden (`c42`). Wrapped, all three age Canals showed, because a refusal with no reason was read as a yes (`c43`) | Shipped 1.1.0: query wrapped, age and unlock guards (`c44`, `c45`) |
| Several Canals in one city | Three Canals in a row through the real build path | The third refused as "already exists" until the buildings got the multiple-per-city flag bridges and walls use (`c27`) | Shipped, 1.0.0 |
| A resource tile as a site | The engine asked directly, with controls | No building of any kind stands on a resource tile, Canal or Grocer, bought or built, and a script can't clear a resource (`c53` to `c55`) | Closed 1.1.0: resource tiles aren't offered |
| A settlement centre as a canal end | A canal beside a city centre | Ships enter a centre that touches coast, so a canal can end at one (`c35`); but a centre counted as part of the shore merged a neck's two shores (`c48`, `c49`) | Shipped 1.1.0: a centre is a way through of its own (`c50`) |
| The Canal valid on Ocean only, sites offered by script | A data-only placement restriction | The engine refused the player's own orders on the land tiles (`b1`) | Closed |
| An unfinished Canal taken out of the queue | Removed from the queue and ordered again | The building stays on its tile with its progress, and the same order takes it up again (`rs1`) | Shipped, 1.4.2 |
| Two-shore and straight-line rules | 1.0.0 to 1.4.3: an isthmus needed water on two separate sides; Exploration a straight two-tile line; Modern five with bends | A canal's own water made its neighbours two-shore tiles and let a fourth Canal onto the side of a cut (`gal-exp`) | Replaced in 1.5.0: one shore is enough, a run is judged as a whole, 1, 2 or 5 tiles by age, any shape |

## Letting the AI dig canals

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| The mod choosing where each AI's canal goes | The AI could already build the Canal; the question was where. The Canal had no placement rule the game could read, so the mod chose the tile for each AI, a worked tile joining two separate waters, and bought or built the Canal there itself, one at a time, eight turns apart | The mod's own canals opened and were used (`c90` to `c98`), but the game's AI was still free to order a Canal on any tile it owned, since the data allowed it everywhere, and such a Canal stayed a building that opened nothing (`w1`) | Shipped 1.1.0, replaced in 1.2.0 by the site marker below, which limits where the AI's own orders can go |
| A bias against the Canal in the AI's lists | The AI's value for the Canal set to -100, then -1000 | The AI still committed a Canal on the same tile on the same turn; the value never reaches that decision (`w1`, `w1b`) | Closed |
| A net that removed stray AI Canals and refunded them | A turn-start sweep | The refund went into the AI's re-queued Canal, which finished again at once, nine turns running (`n1`) | Closed |
| The Canal unlocked for human players only | A data change | Worked, and was rejected: the AI has to be able to dig canals | Closed (`g1`, `g2`) |
| A site marker the Canal requires | A feature with no look and no yield, placed by the mod on each AI's worthwhile sites and on each player order; the Canal requires it on its tile | The engine offers the Canal, to the player and the AI, on marked tiles only; the AI weighed it only there over 49 turns (`m1` to `m8`, `s1`). The marker needs biome rows, no class, and its own yield rows so a marked tile yields what it did bare. A feature can't replace another in one call; clear first, then set (`m8`) | Shipped, 1.2.0 |
| Making the AI choose it | The AI's value for the Canal unraised, at 400, at 3,000 | Unraised the AI weighed it 26 times per site and never chose it; at 400 still lost; at 3,000 an AI committed on its marked site (`s2c`). Safe because it can only build where a site is | Shipped, 1.2.0 |
| AI canals paid with gold alone | Autoplayed 40 to 90 turns | AI treasuries never reach the price; with production they start canals on their own (`c91` to `c96`) | Shipped: the AI uses production or gold as it chooses |

## Yields, the citizen, and a district slot

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| The Canal on an urban district, with a specialist slot | A district re-created on the water tile, with the Canal and with a Fishing Quay | The urban housing block is drawn over the whole hex, on top of anything the mod draws; the canal vanishes (`c14`, `c18`). Specialists seat on urban districts, so a slot means houses | Closed, 2026-09-25 |
| A water building sharing the tile | On 2026-10-18, a Harbor bought onto an open canal with the mod's guard lifted | The tile became an urban district holding the Canal and the Harbor, the fishing boat went, ships still passed, and the channel, quay and boats were gone under the housing block (`wb1`) | Closed, 2026-10-18 |
| A hidden yield type for the tile | A never-buildable yield type carried the canal's food and gold (`c23`) | Worked, and the Canal building can carry the same rows itself | Replaced before 1.0.0 |
| A rural-only building created on a bare tile | `CREATE_ELEMENT` on bare land | Refused; a rural district created first makes the engine add the fishing boat itself (`c21`, `c22b`) | Shipped: the rural district comes first |
| The city's own worked-tile flow | Free the Canal's citizen, place it with the city's expand order, re-create the Canal on the rural district | A rural district with fishing boats and a worker, the Canal's food and gold counted in the city at once and held over turns (`c23` to `c25`) | Shipped, 1.0.0 |
| A limit on ships through a canal per turn | The player's move orders counted per turn: one in Antiquity, two in Exploration | The held moves were dropped silently, and AI movement can't be held at all | Shipped 1.0.0, removed in 1.5.2 |
| Pillaging a canal | A ship and a land unit at an enemy canal | The game never offers a raid on a water tile holding a building; a ship in the canal can still raid the tiles around it (`pl1`, `pl2`) | Known limit, in the README |

## Drawing the canal

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| Let the retype redraw the hex | Retyped and watched | The hex keeps its land mesh for the whole session; a cold reload draws from the save's terrain, so a Coast tile comes back as open sea with the Canal on stilts (`c1`, `c10`). A retype during the load lands after the hex is drawn and changes nothing (`c99b`) | Closed. The canal is drawn by the mod, and saves hold it as land |
| The game's river terrain art, placed by script | `STD_NAVIGABLE_RIVER`, `TER_RiverTerrain_Major_01`, the aquatic flat tile, the flood decal and VFX | Nothing drawn (`c11` to `c13`) | Closed |
| The game's river channel decal | `TER_Decal_RiverPiece_Straight` and `_02`, one per arm, rotated to each shore | A water channel with banks; the rotation mirrors and is corrected. The major-river hex piece draws only river-bed rocks; the water VFX planes draw flat teal shapes | Shipped, 1.0.0 |
| Age dressing | Harbor, quay, wharf, shipyard and river-city house layouts beside the arms; moored fishing boats at the mouths | Draw as designed; a bridge piece draws a whole bridge-town block. Three looks per age, chosen by tile number (`c16`, `c17`, `c34`). The Modern pieces only draw in a Modern game | Shipped, 1.0.0 |
| Locks at a cliff shore | Saqiya chamber, a dockyard gate, the Norse mill, waterfall and mist pieces, each at several positions | Chamber, gatehouse and water wheel read as a lock at 0.40 along the arm; further along it sinks into the cliff; one waterfall shows as a plume, the mist nothing, the dock piece nothing, the cliff rock piece buries the site (`c29` to `c34`) | Shipped, 1.0.0 |
| A custom building type with borrowed art | A `VisualRemaps` row from a type of my own to a shipped building | Registers and reads back as enabled; the tile stays bare ground. Every type a mod adds is invisible unless the mod draws it | Closed, 2026-09-23 |
| A bridge on the canal tile | A Medieval Bridge placed by script on the retyped tile | Entered the simulation and showed nothing in one capture (`c10`) | Not pursued |
| Hiding the opening's redraws | The game redraws the tile at each step of an opening and nothing holds that back. Tried the game's 140 works-like effects | The wonder-construction dust covers the site from the order to the opening and clears itself (`vx1` to `vx5`, `we1`, `we2`) | Shipped, 1.5.1 |
| Redrawing a hex that a load already drew | Retype to land during the load, before the first draw | The load had already drawn it; a save and reload after it draws it right (`c99b`, `c104`) | Shipped 1.1.0: a 1.0.0 save is offered a reload |

## Saves, reloads and age changes

| Route | What I did | What the game did | Where it ended |
| --- | --- | --- | --- |
| Retype to land while the save is written | The retype inside the save's own start event | On a real canal the game crashed, twice; the same save with the hook off did not (`c69` to `c75`) | Closed, 2026-09-28 |
| Retype before the save starts | At the turn end for the autosave, inside a wrapped `saveGame` for the rest, sent once the map reads land; Coast again on completion | Script save, quicksave, autosave and the load-time save all wrote the canal as land with no crash; reloads drew it as a channel through land with a ship pathing through (`c76` to `c81`) | Shipped, 1.1.0 |
| The mod writing the autosave itself | The engine's autosave held off; the mod saved at the start of your turn, on your frequency and keep count, in the game's own series (`c86` to `c88`, `c102`) | Worked, and a save made from a script stops the game for as long as it takes, over a second a turn on a Huge map late in an age (`lag1` to `lag3`) | Shipped 1.1.0, replaced in 1.5.6: the engine's autosave falls about 90 ms after the turn-end event (`te1`), so the canals land in that event and are Coast again as your turn begins |
| Loading an autosave | Watched the load | The game saves again as the game starts, 55 ms after it's playable, so the canals stay land until that save is done (`c78` to `c81`) | Shipped, 1.1.0 |
| A canal through the age change | An Exploration game with an open canal autoplayed into Modern, and the same without Autoplay | The canal comes into the new age as the land it was saved as, with its record, and is opened again once the new age loads (`c100`, `lab3-A`, `w2b2-g6`) | Shipped, 1.1.0 |
| Site markers written during a save | Markers set 50 and 300 ms into a save | All three saves completed (`sv1`) | Shipped 1.2.1: markers wait for the save anyway |

## Still unwatched or unsettled

- A production Canal finishing on an age's last turn opens only in the next age (`lab3-A`); why isn't settled.
- The game's own end-of-age screens with a canal open: the age change was crossed without Autoplay, but on a
  fast-setup game none of the screens came up.
- An AI building a Canal on any 1.5.x build: the soaks ran clean, but no AI queued or built a Canal in them.
