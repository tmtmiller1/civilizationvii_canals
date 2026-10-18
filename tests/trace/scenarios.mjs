// scenarios.mjs - the engine sequences the traces compare: each one a map, the fake engine's options, a setup and an
// act. The same scenario is played against the old single-file script and the modules (tests/trace/run.mjs); a
// change that keeps every step, wait and log line in its place gives the same trace.

// City 1 (player 0) is at C, 3,2. Every tile on row 1 touches the sea on row 0.
const COAST = `
~ ~ ~ ~ ~ ~ ~
 . . . . . . .
. . . C . . .
 . . . . . . .
~ ~ ~ ~ ~ ~ ~
`;
const EX = "BUILDING_CANAL_EXPLORATION";
const at = (x, y) => ({ x, y });
const own = (eng) => { for (let y = 1; y <= 3; y++) for (let x = 0; x < 7; x++) eng.tile(x, y, { own: true }); };
const openRecord = (eng, list) => eng.config.set("Canals_Open_v1", JSON.stringify(list.map(([x, y, land]) =>
  ({ plot: eng.plotOf(at(x, y)), age: "AGE_EXPLORATION", cliffs: [], land: land || "TERRAIN_FLAT" }))));
const pending = (eng, list) => eng.config.set("Canals_Pending_v1", JSON.stringify(list.map(([x, y]) => eng.plotOf(at(x, y)))));

// The engine takes a Canal only on a marked tile, a city's tile for a plain building, and expands onto any owned tile.
function verdicts(eng, { canal = "marked", plain = null } = {}) {
  return (city, type, args) => {
    globalThis.__traceNote(`canStart ${JSON.stringify(city)} ${type} ${JSON.stringify(args)}`);
    const cityID = city != null && typeof city === "object" ? city.id : city;
    if (type === 3) {
      const plots = eng.cities.get(cityID).getPurchasedPlots();
      return { Success: true, Plots: plots, ConstructibleTypes: plots.map(() => eng.typeIndex("IMPROVEMENT_FISHING_BOAT")) };
    }
    const name = args.ConstructibleType == null ? null : eng.typeName(args.ConstructibleType);
    if (name === "BUILDING_MARKET") return { Success: true, Plots: plain || eng.cities.get(cityID).getPurchasedPlots() };
    if (name && name.startsWith("BUILDING_CANAL")) {
      if (args.X == null) return { Success: false, FailureReasons: ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"] };
      const ok = canal === "always" || (canal === "marked" && /CANALS_SITE/.test(String(globalThis.GameplayMap
        .getFeatureType(args.X, args.Y) >= 0 ? globalThis.GameInfo.Features.lookup(globalThis.GameplayMap.getFeatureType(args.X, args.Y)).FeatureType : "")));
      return { Success: ok, FailureReasons: ok ? [] : ["LOC_BUILDING_CONSTRUCT_NO_SUITABLE_LOCATION"], Cost: 400 };
    }
    return { Success: true, Plots: [] };
  };
}
const pathOf = (purchase) => ({ host: purchase ? globalThis.Game.CityCommands : globalThis.Game.CityOperations,
  type: purchase ? 2 : 1, purchase, oCan: (purchase ? globalThis.Game.CityCommands : globalThis.Game.CityOperations).canStart });
const forwarder = (purchase, x, y, eng) => () => (purchase ? globalThis.Game.CityCommands : globalThis.Game.CityOperations)
  .sendRequest(1, purchase ? 2 : 1, { ConstructibleType: eng.typeIndex(EX), X: x, Y: y });

export const SCENARIOS = {
  // openCanal
  "open: a rural tile": { map: COAST, setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM", EX] }); pending(e, [[2, 1]]); },
    act: (M) => M.openCanal(at(2, 1), 0) },
  "open: a rural tile whose boat doesn't land": { map: COAST, options: { refused: ["IMPROVEMENT_FISHING_BOAT"] },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM", EX] }); },
    act: (M) => M.openCanal(at(2, 1), 0) },
  "open: an urban tile with an old building": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_URBAN", builds: ["BUILDING_LIBRARY", EX] }); },
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e); return M.openCanal(at(2, 1), 0); } },
  "open: a tile shared with a building of the age": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_URBAN", builds: ["BUILDING_ACADEMY", EX] }); pending(e, [[2, 1]]); },
    act: (M) => M.openCanal(at(2, 1), 0) },
  "open: outside the local turn": { map: COAST, options: { turnActive: false },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: [EX] }); }, act: (M) => M.openCanal(at(2, 1), 0) },
  "open: water already, no record": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: (M) => M.openCanal(at(2, 1), 0) },
  "open: an unfinished Canal": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: [{ type: EX, complete: false }] }); },
    act: (M) => M.openCanal(at(2, 1), 0) },
  "open: cliffs on the tile": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM", EX], cliffs: [4, 5] }); },
    act: (M) => M.openCanal(at(2, 1), 0) },

  // placeCanal, called as the sendRequest wrap calls it
  "place: bought on a rural tile": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM"] }); },
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e); return M.placeCanal(1, at(2, 1), e.typeIndex(EX), forwarder(true, 2, 1, e), pathOf(true)); } },
  "place: built on a bare tile": { map: COAST, setup: (e) => own(e),
    act: (M, e) => { globalThis.Game.CityOperations.canStart = verdicts(e); return M.placeCanal(1, at(4, 1), e.typeIndex(EX), forwarder(false, 4, 1, e), pathOf(false)); } },
  "place: bought on an urban tile with an old building": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_URBAN", builds: ["BUILDING_LIBRARY", "BUILDING_PALACE"] }); },
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e); return M.placeCanal(1, at(2, 1), e.typeIndex(EX), forwarder(true, 2, 1, e), pathOf(true)); } },
  "place: refused by the engine": { map: COAST, setup: (e) => own(e),
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e, { canal: "never" }); return M.placeCanal(1, at(4, 1), e.typeIndex(EX), forwarder(true, 4, 1, e), pathOf(true)); } },
  "place: the engine never places it": { map: COAST, options: { forwardIgnored: true },
    // since the old script: the Library the order took off is put back
    changed: { added: [/CREATE_ELEMENT .*BUILDING_LIBRARY/, /put back at 2,1/], state: /^2,1 /,
      check: (now) => now.state.includes("2,1 FLAT owner=0 city=1 district=URBAN feature=- builds=BUILDING_LIBRARY") },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_URBAN", builds: ["BUILDING_LIBRARY"] }); },
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e); return M.placeCanal(1, at(2, 1), e.typeIndex(EX), forwarder(true, 2, 1, e), pathOf(true)); } },
  "place: sold by the mod": { map: COAST,
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL" }); },
    act: (M, e) => {
      const place = () => globalThis.Game.PlayerOperations.sendRequest(0, "CREATE_ELEMENT", { Kind: "CONSTRUCTIBLE", Type: EX, Location: at(2, 1), Owner: 0 });
      return M.placeCanal(1, at(2, 1), e.typeIndex(EX), place, { ...pathOf(true), soldFor: 400 });
    } },
  "place: the district for a bare tile doesn't land": { map: COAST, options: { refused: ["DISTRICT_RURAL"] }, setup: (e) => own(e),
    act: (M, e) => M.placeCanal(1, at(4, 1), e.typeIndex(EX), forwarder(true, 4, 1, e), pathOf(true)) },

  // the whole path: install, then the orders a player gives
  "install, then buy, build and refuse": { map: COAST, options: { techs: ["NODE_TECH_EX_SHIPBUILDING"], queryHasCanal: true },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: ["IMPROVEMENT_FARM"] }); e.tile(5, 1, { district: "DISTRICT_URBAN", builds: ["BUILDING_LIBRARY"] }); },
    act: async (M, e) => {
      globalThis.Game.CityCommands.canStart = verdicts(e); globalThis.Game.CityOperations.canStart = verdicts(e);
      const ok = M.install();
      const C = globalThis.Game.CityCommands, B = globalThis.Game.CityOperations;
      const ct = e.typeIndex(EX);
      const reads = [ok, C.canStart(1, 2, { ConstructibleType: ct }, false), C.canStart(1, 2, { ConstructibleType: ct, X: 2, Y: 1 }, false),
        C.canStart(1, 2, { ConstructibleType: ct, X: 3, Y: 3 }, false), B.canStart(1, 1, { ConstructibleType: ct }, false),
        C.canStart(1, 2, { ConstructibleType: e.typeIndex("BUILDING_CANAL_ANTIQUITY") }, false),
        B.canStart(1, 1, { ConstructibleType: e.typeIndex("BUILDING_MARKET") }, false),
        C.canStartQuery(1, 2, 7), B.canStartQuery(1, 1, 7)];
      reads.push(C.sendRequest(1, 2, { ConstructibleType: ct, X: 2, Y: 1 }));
      await new Promise((r) => setTimeout(r, 6000));
      reads.push(C.canStart(1, 2, { ConstructibleType: e.typeIndex("BUILDING_MARKET"), X: 2, Y: 1 }, false));
      reads.push(C.sendRequest(1, 2, { ConstructibleType: e.typeIndex("BUILDING_MARKET"), X: 2, Y: 1 }));
      reads.push(B.sendRequest(1, 1, { ConstructibleType: ct, X: 5, Y: 1 }));
      reads.push(B.sendRequest(1, 1, { ConstructibleType: ct, X: 3, Y: 3 }));
      return reads;
    } },
  // a Canal ordered by production, waiting in the queue before it shows on the map: its tile is kept off every other
  // building's lists and a request aimed at it refused, as on an opened canal, until the Canal leaves the queue (ow7)
  "install, a queued Canal's tile kept off other buildings": { map: COAST, only: "new",
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL" }); e.queue(1, EX, 2, 1); },
    act: (M, e) => {
      globalThis.Game.CityCommands.canStart = verdicts(e); globalThis.Game.CityOperations.canStart = verdicts(e);
      M.install();
      const C = globalThis.Game.CityCommands, B = globalThis.Game.CityOperations;
      const mk = e.typeIndex("BUILDING_MARKET"); const p = e.plotOf(at(2, 1));
      const read = () => ({ build: (B.canStart(1, 1, { ConstructibleType: mk }, false).Plots || []).includes(p),
        buy: (C.canStart(1, 2, { ConstructibleType: mk }, false).Plots || []).includes(p),
        here: C.canStart(1, 2, { ConstructibleType: mk, X: 2, Y: 1 }, false) });
      const queued = read();
      const sent = C.sendRequest(1, 2, { ConstructibleType: mk, X: 2, Y: 1 });
      e.cities.get(1).queue.length = 0;
      const freed = read();
      return { queued, sent, freed };
    },
    check: (now) => {
      const r = now.result;
      return !r.queued.build && !r.queued.buy && r.queued.here.Success === false
        && r.queued.here.FailureReasons[0] === "LOC_CANAL_TILE_TAKEN" && r.sent === false
        && !now.trace.some((l) => /CityCommands\.sendRequest .*"X":2,"Y":1/.test(l))
        && r.freed.build && r.freed.buy && r.freed.here.Success === true;
    } },
  "install, short of gold": { map: COAST, options: { gold: 100 },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL" }); },
    act: (M, e) => {
      globalThis.Game.CityCommands.canStart = verdicts(e); globalThis.Game.CityOperations.canStart = verdicts(e);
      M.install();
      const C = globalThis.Game.CityCommands; const ct = e.typeIndex(EX);
      return [C.canStart(1, 2, { ConstructibleType: ct }, false), C.canStart(1, 2, { ConstructibleType: ct, X: 2, Y: 1 }, false),
        C.canStartQuery(1, 2, 7), C.sendRequest(1, 2, { ConstructibleType: ct, X: 2, Y: 1 })];
    } },
  "install, a Canal its tech should have unlocked, sold by the mod": { map: COAST, options: { techs: ["NODE_TECH_EX_SHIPBUILDING"] },
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL" }); },
    act: async (M, e) => {
      const v = verdicts(e);
      const locked = (cityID, type, args) => (args && args.ConstructibleType != null && e.typeName(args.ConstructibleType) === EX
        ? { Success: false, Locked: true, NeededUnlock: 0, FailureReasons: [] } : v(cityID, type, args));
      globalThis.Game.CityCommands.canStart = locked; globalThis.Game.CityOperations.canStart = locked;
      M.install();
      const C = globalThis.Game.CityCommands; const ct = e.typeIndex(EX);
      const reads = [C.canStart(1, 2, { ConstructibleType: ct }, false), C.canStart(1, 2, { ConstructibleType: ct, X: 2, Y: 1 }, false),
        C.canStartQuery(1, 2, 7), C.sendRequest(1, 2, { ConstructibleType: ct, X: 2, Y: 1 })];
      await new Promise((r) => setTimeout(r, 6000));
      return reads;
    } },
  "install in a network game": { map: COAST, options: { multiplayer: true }, setup: (e) => own(e),
    act: (M, e) => { globalThis.Game.CityCommands.canStart = verdicts(e); M.install();
      return globalThis.Game.CityCommands.canStart(1, 2, { ConstructibleType: e.typeIndex(EX) }, false); } },
  "install, then uninstall": { map: COAST, setup: (e) => own(e), act: (M) => { M.install(); M.uninstall(); return Object.keys(globalThis.Game.CityCommands); } },
  // up to 1.5.5 the turn start wrote the mod's own autosave (land, Network.saveGame, Coast); now the turn start only
  // sweeps, and the engine's autosave is left to run between the turns (the next scenario)
  "install, a turn, a Canal completed": { map: COAST, only: "new",
    setup: (e) => { own(e); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: [EX] }); e.tile(5, 1, { district: "DISTRICT_RURAL", builds: [EX] }); pending(e, [[5, 1]]); openRecord(e, [[0, 1]]); e.tile(0, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX, "IMPROVEMENT_FISHING_BOAT"] }); },
    act: async (M, e) => {
      M.install();
      await new Promise((r) => setTimeout(r, 5000));
      e.fire("PlayerTurnDeactivated", { player: 0 });
      e.fire("PlayerTurnActivated", { player: 0 });
      await new Promise((r) => setTimeout(r, 30000));
      e.fire("ConstructibleBuildCompleted", { location: at(2, 1), constructibleType: e.typeIndex(EX), constructible: { owner: 0 } });
    },
    check: (now) => !now.trace.some((l) => /Network\.saveGame|setAutoSaveFrequency/.test(l))
      && now.trace.filter((l) => /canal opened at/.test(l)).length === 2
      && now.state.some((l) => /^0,1 COAST/.test(l)) && now.state.includes("autosave frequency=1") },
  // the engine's autosave between the turns (te1: StartSaveRequest about 90 ms after TurnEnd, TurnBegin after
  // SaveComplete): the canals land in the TurnEnd handler, saved as land, Coast again at TurnBegin
  "install, turn end, the engine's autosave, turn begin": { map: COAST, only: "new",
    setup: (e) => { own(e); openRecord(e, [[2, 1], [4, 1]]); for (const x of [2, 4]) e.tile(x, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: async (M, e) => {
      M.install();
      await new Promise((r) => setTimeout(r, 5000));
      e.fire("TurnEnd", {}); globalThis.__traceNote(`read ${globalThis.GameplayMap.getTerrainType(2, 1)},${globalThis.GameplayMap.getTerrainType(4, 1)}`);
      await new Promise((r) => setTimeout(r, 90)); e.fire("StartSaveRequest", {});
      await new Promise((r) => setTimeout(r, 1400)); e.fire("SaveComplete", {});
      await new Promise((r) => setTimeout(r, 40)); e.fire("TurnBegin", {});
      await new Promise((r) => setTimeout(r, 500)); e.fire("PlayerTurnActivated", { player: 0 });
      await new Promise((r) => setTimeout(r, 5000));
    },
    check: (now) => {
      const t = now.trace; const after = (k, re) => t.findIndex((l, n) => n > k && re.test(l));
      const end = t.findIndex((l) => /event TurnEnd/.test(l)), save = after(end, /event StartSaveRequest/), done = after(save, /event SaveComplete/);
      const land = after(end, /setTerrain TERRAIN_FLAT \{"x":2/), land2 = after(end, /setTerrain TERRAIN_FLAT \{"x":4/);
      const coast = after(save, /setTerrain TERRAIN_COAST \{"x":2/);
      return end >= 0 && land > end && land < save && land2 > end && land2 < save && coast > done
        && !t.some((l) => /Network\.saveGame/.test(l)) && now.state.some((l) => /^2,1 COAST/.test(l)) && now.state.some((l) => /^4,1 COAST/.test(l));
    } },
  // a player coming from 1.5.5 with a game that left the frequency held: their own value is back as the mod installs
  "install, a frequency 1.5.5 left held": { map: COAST, only: "new", options: { autosave: 1003 }, setup: (e) => own(e),
    act: (M) => M.install(),
    check: (now) => now.trace.some((l) => /Configuration\.setAutoSaveFrequency 3$/.test(l)) && now.state.includes("autosave frequency=3") },
  "install, the age ends": { map: COAST, options: { ageOver: true },
    setup: (e) => { own(e); openRecord(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: async (M, e) => { M.install(); await new Promise((r) => setTimeout(r, 8000)); e.fire("GameAgeEnded", {}); e.fire("BeforeAgeTransition", {}); } },

  // repairs
  "repair: an open canal's district without a city": { map: COAST,
    setup: (e) => { own(e); openRecord(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_RURAL", cityless: true, terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: (M) => M.repairCitylessDistricts() },
  "repair: an open canal missing its Canal": { map: COAST,
    setup: (e) => { own(e); openRecord(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST" }); },
    act: (M) => M.repairCitylessDistricts() },
  "repair: a pending tile's urban district without a city": { map: COAST, options: { techs: [] },
    setup: (e) => { own(e); pending(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_URBAN", cityless: true, builds: ["BUILDING_BANK", { type: "BUILDING_KILN", complete: false }] });
      e.queue(1, "BUILDING_MARKET", 0, 3); e.queue(1, "BUILDING_ACADEMY", 2, 1); },
    act: (M, e) => { globalThis.Game.CityOperations.canStart = verdicts(e); return M.repairCitylessDistricts(); } },
  "repair: the rebuilt district lands without a city again": { map: COAST, options: { refused: ["PARENT"] },
    setup: (e) => { own(e); pending(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_URBAN", cityless: true, builds: ["BUILDING_BANK"] }); },
    act: (M) => M.repairCitylessDistricts() },
  "repair: the city won't take the order again": { map: COAST,
    setup: (e) => { own(e); pending(e, [[2, 1]]); e.tile(2, 1, { district: "DISTRICT_URBAN", cityless: true, builds: ["BUILDING_BANK"] });
      e.queue(1, "BUILDING_ACADEMY", 2, 1); },
    act: (M, e) => { const v = verdicts(e); globalThis.Game.CityOperations.canStart = (c, t, a) =>
      (a.ConstructibleType != null && e.typeName(a.ConstructibleType) === "BUILDING_ACADEMY" ? { Success: false, FailureReasons: ["LOC_NO"] } : v(c, t, a));
      return M.repairCitylessDistricts(); } },
  "repair: a broken canal no city of its owner holds": { map: COAST,
    setup: (e) => { openRecord(e, [[2, 1]]); e.tile(2, 1, { terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: (M) => M.repairCitylessDistricts() },
  "repair: a cityless district on the map, held by another player": { map: COAST,
    setup: (e) => { own(e); e.tile(4, 3, { district: "DISTRICT_URBAN", cityless: true, builds: ["BUILDING_BANK"] }); },
    act: (M) => M.repairCitylessDistricts() },

  // the turn-start sweep
  "sweep: a pending Canal finished, one finished off the list, an open canal": { map: COAST,
    setup: (e) => { own(e); pending(e, [[2, 1], [6, 3]]); e.tile(2, 1, { district: "DISTRICT_RURAL", builds: [EX] }); e.tile(5, 1, { district: "DISTRICT_RURAL", builds: [EX] });
      openRecord(e, [[0, 1]]); e.tile(0, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX, "IMPROVEMENT_FISHING_BOAT"] }); },
    act: (M) => M.sweep() },

  // site markers
  "sites: queued, pending, open and stale": { map: COAST,
    setup: (e, M) => { own(e); e.queue(1, EX, 4, 1); pending(e, [[1, 1]]); openRecord(e, [[0, 1]]); M.state.localId = 0;
      e.addCity(2, 1, 6, 3); e.queue(2, EX, 6, 2); e.queue(2, "BUILDING_MARKET", 5, 3);
      e.tile(0, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] });
      e.tile(6, 1, { feature: "FEATURE_CANALS_SITE" }); e.tile(5, 1, { feature: "FEATURE_FOREST" });
      e.config.set("Canals_Sites_v1", JSON.stringify({ [e.plotOf(at(6, 1))]: "" })); },
    act: async (M) => { await M.syncSites(); return [...M.queuedCanalOrders()]; } },
  // the same, with three AI settlements and a clock that moves 5 ms at every read, so the modules' AI pass waits for a
  // frame before each settlement: the markers and records come out as from the pass run whole
  "sites: the AI pass split over frames": { map: COAST,
    setup: (e, M) => { own(e); e.queue(1, EX, 4, 1); pending(e, [[1, 1]]); openRecord(e, [[0, 1]]); M.state.localId = 0;
      e.addCity(2, 1, 6, 3); e.queue(2, EX, 6, 2); e.addCity(3, 1, 0, 3); e.addCity(4, 1, 2, 3);
      e.cities.get(3).getPurchasedPlots = () => [e.plotOf(at(0, 1)), e.plotOf(at(1, 1)), e.plotOf(at(0, 2))];
      e.cities.get(4).getPurchasedPlots = () => [e.plotOf(at(2, 1)), e.plotOf(at(3, 1))];
      e.tile(0, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] });
      e.tile(6, 1, { feature: "FEATURE_CANALS_SITE" }); e.tile(5, 1, { feature: "FEATURE_FOREST" });
      e.config.set("Canals_Sites_v1", JSON.stringify({ [e.plotOf(at(6, 1))]: "" }));
      let t = 0; globalThis.performance = { now: () => (t += 5) }; },
    act: async (M) => { await M.syncSites(); return [...M.queuedCanalOrders()]; } },
  "sites: a marker over woods, then taken off": { map: COAST, setup: (e) => { own(e); e.tile(5, 1, { feature: "FEATURE_FOREST" }); },
    act: async (M) => { const a = await M.markSite(at(5, 1)); await M.unmarkSite(at(5, 1)); return a; } },

  // the save wrap
  "save: canals to land, saved, Coast again": { map: COAST,
    setup: (e) => { own(e); openRecord(e, [[2, 1], [4, 1]]); e.tile(2, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] }); e.tile(4, 1, { district: "DISTRICT_RURAL", terrain: "TERRAIN_COAST", builds: [EX] }); },
    act: (M, e) => { M.state.enabled = true; M.wrapSaveGame(globalThis.Network); globalThis.engine.on("StartSaveRequest", M.onSaveStart); globalThis.engine.on("SaveComplete", M.onSaveDone);
      return globalThis.Network.saveGame({ FileName: "x" }); } },

  // the parked ship limit
  "ships: the parked limit's wrap": { map: COAST,
    setup: (e) => { e.config.set("Canals_Open_v1", JSON.stringify([{ plot: e.plotOf(at(2, 1)), age: "AGE_ANTIQUITY", cliffs: [] }])); },
    act: (M) => { const sent = []; const f = M.wrapUnitSend((...a) => { sent.push(a); return true; });
      globalThis.Units.getPathTo = () => ({ plots: [globalThis.GameplayMap.getIndexFromLocation(at(2, 1))] });
      globalThis.Units.get = () => ({ location: at(1, 1) });
      return [f(1, "MOVE_TO", { X: 3, Y: 1 }), f(2, "MOVE_TO", { X: 3, Y: 1 }), f(3, "OTHER", {}), sent.length]; } },
};
