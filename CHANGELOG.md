# Changelog

All notable changes to Canals are documented here. This project follows semantic versioning. The routes that
were tried before this design, the probes and the harness runs live in the author's working tree
(`mod_ideas_tested/canals`), outside this folder.

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
