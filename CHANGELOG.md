# Changelog

All notable changes to Canals are documented here. This project follows semantic versioning. The routes that
were tried before this design, the probes and the harness runs live in the author's working tree
(`mod_ideas_tested/canals`), outside this folder.

## [1.4.1] - 2026-10-04

- No change in game: the mod plays exactly as 1.4.0. Repository housekeeping only.

## [1.4.0] - 2026-10-04

- One-tile canals, an alternative set of rules chosen in Options, Add-ons, under Canals: Canal rules. "By age" is the
  mod as before and stays the default. "One-tile canals" replaces the three age Canals with a single Canal that is
  the same in every age: unlocked by Irrigation in Antiquity and needing no tech after that, 400 Production, +2 Food
  and +2 Gold, always one tile and never next to another canal, and no limit on how many ships pass it each turn. It
  is drawn in the style of the age being played, so a canal dug in Antiquity is redrawn as an Exploration canal, then
  a Modern one, as the game moves on.
- The choice made in the main menu applies to new games; the first time a game loads it keeps that choice, and
  changing it during a game applies to that game from then on. Canals already dug keep the rules they were dug
  under, and a Canal already ordered is finished under its own rules.
- The AI follows the same rules: it is offered only the Canal of the rules in play, on its own kind of site.
- A Civilopedia chapter, One-Tile Canals, on the Canals page.
- A canal whose opening was cut short is rebuilt. Opening a finished Canal takes a few seconds of steps; if they were
  cut off part-way, the tile was left as water with no district, no fishing boat and no Canal building, so it gave
  nothing. Now, as each of your turns begins and as a game loads, any open canal missing its district or its Canal is
  settled again: a rural district held by its city, the Canal of its own kind and its site marker. This also repairs
  such a canal in a save made with an earlier version.
- A Canal opens only during your own turn. One that finishes in another player's turn opens as your next turn begins.

## [1.3.1] - 2026-10-01

- Repairs a tile left broken by an unfinished Canal. Before 1.2.2, ordering a Canal on a tile with no district made
  an urban district there that belonged to no city. If the Canal never finished, that district stayed: it looked
  like an empty urban quarter, and buildings put on it completed but were not drawn and gave their city nothing.
  1.2.2 repaired only canals and Canal orders still in progress, so such a tile stayed broken.
- This repairs games started with Canals 1.2.1 or earlier. Load such a save once with Canals 1.3.1 enabled: as it
  loads, the mod reads the map once, and any urban or rural district on a major civilization's land that belongs to
  no city is rebuilt for the city that owns the tile, with every finished building and improvement on it put back.
  Save the game afterwards and the repair is kept; the map is not read again for that game. A game started with
  1.2.2 or later has no such districts, and the check finds nothing.
- The repaired buildings count for the city and are drawn, and they cost their upkeep like any of the city's
  buildings, which can turn its happiness negative.
- Your city's production orders for such a tile are kept: each is ordered again on the repaired tile in its old place
  in the queue, and a building left unfinished there is ordered again at the end of the queue. Without this a
  building finished there stayed without a city, and the queue could stall on it. Progress already put into an
  order is not carried over.
- The README lists a known limit: a canal cannot be pillaged, because the game never offers a raid on a water tile
  that holds a building. A ship in an enemy canal can still Coastal Raid the tiles around it.

## [1.3.0] - 2026-10-01

- A Canals group in the Civilopedia's Game Concepts section: what a Canal is and each age's Canal, which tiles
  qualify, longer canals, and ship traffic and yields.
- Translated into German, Spanish, French, Italian, Japanese, Korean, Polish, Brazilian Portuguese, Russian, and
  Simplified and Traditional Chinese: the mod's name and description, the building names, the placement messages,
  the notices and the Civilopedia pages. Game terms use the game's own translations.

## [1.2.2] - 2026-09-30

- Fixes a crash on ending the turn. An opened canal's tile holds a rural district, and for every AI canal (and a
  player's canal the city did not settle itself) the mod made that district without a city. That did no harm while
  the canal was water, but the tile is land in every save, in the next age, and for good once Canals is turned off,
  and the first time an AI put an urban building on it the game crashed. Every district the mod makes now belongs to
  the city that owns the tile, and one that does not is taken off rather than left.
- Games already affected are repaired: after a load and at each turn start, an opened canal or a Canal site whose
  district belongs to no city has it rebuilt for its city, with the Canal building and fishing boat as before. Load
  the save once with Canals 1.2.2 enabled; its saves are then safe with the mod on or off.
- A canal tile whose district had no city gave its city nothing; held by the city, the tile's food and gold reach it
  again (2 food 2 gold on a fished canal).

## [1.2.1] - 2026-09-30

- A tile is no canal site when one of its shores is water nothing can enter: ice, or a natural wonder that stands
  in the sea (Thera, Seongsan Ilchulbong). Before, such a tile beside Thera was offered and could be bought, and the
  canal opened onto the wonder, which no ship crosses; the AI's site worth read it the same way.
- A Canal in any settlement's build queue, an AI's included, keeps the canal site on its tile until the order is
  done with. Before, an AI site that stopped being worth marking lost its marker with the AI's Canal still queued
  on it, and the engine was left holding an order it could no longer place.
- An opened canal keeps the canal site under its Canal building, as the building requires; the site yields what
  bare coast does, so the tile's yields do not change. Canals opened by 1.2.0 get theirs at the next turn start.
- A canal is on record the moment its tile is water, before the rest of its opening, and a save that starts in
  those seconds waits for the opening to finish, then lands the canal with the others and holds it whole. Before,
  such a save carried the tile as open sea with no record.
- No map edit is made while a save is being written: a Canal that completes during one opens at the next turn
  start, and site markers wait for the save to finish. A map edit that fails no longer leaves the edit block open.
- A canal whose tile the game turns to water late (it can take a few seconds on a busy turn) still opens. Before,
  the mod stopped waiting after three seconds and the Canal stayed a building on a water tile.

## [1.2.0] - 2026-09-29

- AI players build Canals themselves, as they build any building, and only on real canal sites. The mod marks, for
  each AI, every tile of its settlements where a canal is worth digging: where it saves a ship at least six tiles of
  sailing round, or opens a lake or sea of ten tiles or more. The game offers an AI the Canal on those tiles and
  nowhere else, and the AI decides when to build it, with production or gold. Its canals open and are drawn like
  yours. Before, the mod dug AI canals itself, on the first site it found, and the game's own AI could also put a
  Canal on any tile it owned, where it stayed a building and opened nothing.
- The Canal needs a canal site on its tile, a marker the mod places. Your build and purchase lists work as before:
  ordering a Canal marks its tile. A marked tile yields what it did. On an AI site that held woods or wetland the
  marker takes their place until the site is dropped, when they come back.

## [1.1.1] - 2026-09-29

- National Park land is never offered as a Canal site, and a Canal ordered onto it is refused before the tile is
  touched, whichever of the two mods loads first. Before, when Canals' script loaded after National Park's, a park
  tile could be listed and bought, and the Canal was dug through the park.

## [1.1.0] - 2026-09-28

- A canal keeps its look across a save and reload. A coast tile loads as open sea, so a canal reloaded as an open
  strait; saves now hold each canal as the land it was cut from, and after a load it is water again under the
  channel, still drawn through land. This covers the autosave, saves from the menu, the quicksave key, and the save
  the game makes on loading an autosave.
- AI players dig canals. An AI with the Canal unlocked picks a tile it works that joins two separate bodies of water,
  and its city builds the Canal there with its production, as a player's does, or buys it outright when it has the
  gold with a fifth to spare. The canal opens and is drawn like a player's. Each AI has one Canal under way at a time
  and waits eight turns between canals.
- Canals are water through every AI turn, so AI units sail through them.
- While a canal is open, the mod writes the autosave itself at the start of your turn, on your own autosave
  frequency and keep count. The files carry on the game's own series (AutoSave_01_0072 and onward) and the oldest
  past your keep count is deleted, so the newest autosave is at the top of the Autosaves tab and is the one Continue
  loads. The game's own autosave is held for that time; the Options screen shows your own frequency, a value set
  there becomes your setting, and your setting is put back whenever the main menu loads.
- A save from Canals 1.0.0 held its canals as open water, so they load drawn as open sea. The mod now says so on
  loading such a save and offers to fix it at once: Reload now writes this turn's autosave, with the canals saved as
  land, and loads it. Otherwise they are drawn as canals after your next save and load.
- A canal keeps its look across an age transition. The next age is built from the map the old one leaves, so a
  canal still water at that point came into the new age as open sea. The canals now turn to land as the age ends and
  open again once the new age has loaded; with one more turn chosen instead, they are water again for it.
- In a game Canals was added to after the Canal's tech was researched, the game keeps that Canal locked for the rest
  of the age: its unlock only happens at the moment the tech is researched. The mod now sells it for gold in each
  settlement's purchase list and places it itself, and says so once when the game loads. The AI planner treats
  such a Canal as open too.
- In a multiplayer game the mod says at the start that no Canal can be built there, and a Canal asked for directly is
  refused with the same reason. The mod's description in Additional Content says it is for single-player games.
- Nothing else can be built on a canal tile. A Garden or a Harbor was offered the tile as a place to expand onto.
- Where canals meet, the junction is drawn as one open basin, and locks appear only where a channel meets a natural
  shore that was a cliff.
- With Canals removed, a dug canal loads as a land tile of the city instead of water.
- Towns can have canals. A town buys the Canal with gold from its purchase list, and a city can buy one the same
  way; the purchase placement screen offers the canal sites only, and a bought Canal opens at once.
  A canal runs on from one settlement's land into another's in any mix of cities and towns: a tile beside another
  settlement's canal is offered as the next tile of it.
- The Canal is listed wherever it can be built. The lists are drawn from the engine's own judgement of a building,
  which is blind to canal sites, so a town was offered no Canal at all; the mod's verdict now reaches the list.
- Only the Canal of the age being played is offered, and only once its tech is in. Both were open before: a refusal
  the engine gives without a reason, which is what it returns for a locked or wrong-age building, was read as a yes.
- A settlement standing next to a neck of land no longer takes away the neck's own canal site. A city or town
  center is a way through for a ship in its own right, and is counted as one rather than as a piece of the water
  beside it, which could bridge a neck's two shores and read them as a single coast.
- A tile that holds a resource is no longer offered as a canal site. The game allows no building on a resource
  tile, so such a Canal was refused once it was ordered; now the site is not offered, and asking for it directly
  gives a message saying why.
- A canal is drawn as a channel between its shores. A tile with water on several sides used to get a channel arm
  toward every one of them and looked like a star; it now gets one arm to each canal beside it and otherwise the two
  shores that lie most nearly opposite. Where the canal also touches a separate body of water, such as a lake beside
  the cut, one branch opens into it from a single tile, so it is plain that ships can come in that way.
- The three Canals are named for their age: Ancient Canal, Medieval Canal and Modern Canal.
- Each Canal has its own building icon.

## [1.0.0] - 2026-09-25

First release. Watched working end to end on Civilization VII 1.5.0 in games of all three ages; the run behind
each step is in `docs/verification-runs.md`.

- A Canal building for each age, in the ordinary production list, unlocked by Engineering, Shipbuilding and
  Industrialization, at 300, 500 and 800 production. A city can dig as many canals as it has sites for.
- The placement screen offers only canal sites: a land tile the city owns, within its build ring, with sea, lake
  or navigable river on at least two separate sides. A city or town center counts as a canal end.
- When the Canal completes the tile becomes water and any ship can sail through it in the same turn. The retype
  survives a save and reload.
- Longer canals from the Exploration age: a straight two-tile line in Exploration, runs of up to five tiles that
  may bend and branch in Modern. Each opening redraws its neighbors so the channels meet.
- The finished canal is a worked fishing tile of the city and the Canal stays on it as a building with its own
  food and gold: 2 and 2 in Antiquity, 3 and 4 in Exploration, 4 and 6 in Modern.
- Ships through a canal per turn: one for an Antiquity canal, two for Exploration, unlimited for Modern.
- The canal is drawn in the age it was dug in: a channel toward each shore, moored boats at the mouths, and an
  Antiquity harbor and quay, Exploration houses and a wharf, or Modern buildings and a harbor along the banks.
  Three looks per age, chosen by tile so a canal keeps its look across reloads.
- A canal cut at a cliff shore is drawn stepping down through a lock: chamber, gates, gatehouse and water wheel.
- Adds three buildings and their tech unlocks, changes no base-game rows, replaces no base-game files. A save
  loads with the mod on or off.
- Single player. In a network game the Canal is not offered.
- English only for now.
