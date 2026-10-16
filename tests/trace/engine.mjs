// engine.mjs - Canals: a fake game engine for the sequence traces (tests/canal-sequences.test.mjs).
//
// Everything the mod's engine sequences touch: the map with its districts and constructibles, cities and their
// queues, players, the operation hosts, WorldBuilder, the save calls and engine events. Requests land after a fixed
// virtual delay (a destroy or create 150 ms later, a retype 200 ms), so the mod's wait loops run part-way as they do
// in a game. Time is virtual: setTimeout and Date.now run off one clock, and run() fires the timers in order with
// every microtask drained between them, so a run is the same every time. Every engine call and every log line is
// written to the trace with the time it happened.
//
// A map is drawn as in tests/fake-game.mjs: ~ coast, . flat, h hill, C a settlement centre (city 1, player 0); a
// tile is then dressed with tile(x, y, {...}).

const RING = ["DIRECTION_EAST", "DIRECTION_SOUTHEAST", "DIRECTION_SOUTHWEST", "DIRECTION_WEST",
  "DIRECTION_NORTHWEST", "DIRECTION_NORTHEAST"];
const STEP_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const STEP_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];
const TERRAINS = ["TERRAIN_MOUNTAIN", "TERRAIN_HILL", "TERRAIN_FLAT", "TERRAIN_COAST", "TERRAIN_OCEAN",
  "TERRAIN_NAVIGABLE_RIVER"];
const FEATURES = [{ FeatureType: "FEATURE_FOREST", FeatureClassType: "FEATURE_CLASS_VEGETATED" },
  { FeatureType: "FEATURE_CANALS_SITE" }, { FeatureType: "FEATURE_CANALS_SITE_ONE_TILE" },
  { FeatureType: "FEATURE_ICE", Impassable: true }];
const AGES = ["AGE_ANTIQUITY", "AGE_EXPLORATION", "AGE_MODERN"];
const DISTRICTS = ["DISTRICT_CITY_CENTER", "DISTRICT_URBAN", "DISTRICT_RURAL"];
const CONSTRUCTIBLES = [
  ["BUILDING_CANAL_ANTIQUITY", "BUILDING", "AGE_ANTIQUITY"], ["BUILDING_CANAL_EXPLORATION", "BUILDING", "AGE_EXPLORATION"],
  ["BUILDING_CANAL_MODERN", "BUILDING", "AGE_MODERN"], ["BUILDING_CANAL_ONE_TILE", "BUILDING", null],
  ["BUILDING_LIBRARY", "BUILDING", "AGE_ANTIQUITY"], ["BUILDING_ACADEMY", "BUILDING", "AGE_EXPLORATION"],
  ["BUILDING_PALACE", "BUILDING", "AGE_ANTIQUITY"], ["BUILDING_MARKET", "BUILDING", "AGE_EXPLORATION"],
  ["BUILDING_BANK", "BUILDING", "AGE_EXPLORATION"], ["BUILDING_KILN", "BUILDING", "AGE_EXPLORATION"],
  ["IMPROVEMENT_FARM", "IMPROVEMENT", null], ["IMPROVEMENT_FISHING_BOAT", "IMPROVEMENT", null]];

function table(key, rows) {
  const list = rows.map((r, i) => ({ ...r, $index: i }));
  return {
    lookup: (k) => (typeof k === "number" ? list[k] : list.find((r) => r[key] === k)) ?? null,
    find: (f) => list.find(f), filter: (f) => list.filter(f), forEach: (f) => list.forEach(f),
    [Symbol.iterator]: () => list[Symbol.iterator]()
  };
}
const hashOf = (t) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** The fake game. `options`: age (0-2), turn, local turn active, multiplayer, refused (types a create ignores). */
export function makeEngine(picture, options = {}) {
  const trace = [];
  let now = 0; let seq = 0; let nextId = 100;
  const timers = [];
  const rows = picture.split("\n").filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));
  const W = rows[0].length, H = rows.length;
  const tiles = [];
  const cities = new Map();
  const players = new Map();
  rows.forEach((r, y) => r.forEach((ch, x) => {
    const t = { terrain: ch === "~" ? "TERRAIN_COAST" : ch === "h" ? "TERRAIN_HILL" : "TERRAIN_FLAT", feature: null,
      district: null, builds: [], owner: -1, city: null, units: [], area: ch === "~" ? 1 : 2, resource: false };
    if (ch === "C") { t.district = { type: "DISTRICT_CITY_CENTER", id: nextId++, city: 1 }; t.owner = 0; t.city = 1; }
    tiles.push(t);
  }));
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? tiles[y * W + x] : null);
  const step = (x, y, d) => { const [dx, dy] = (y & 1 ? STEP_ODD : STEP_EVEN)[d]; return { x: x + dx, y: y + dy }; };
  const cube = (x, y) => { const q = x - (y - (y & 1)) / 2; return [q, y, -q - y]; };
  const J = (o) => JSON.stringify(o);
  const note = (what) => trace.push(`${String(now).padStart(6)} ${what}`);
  const later = (ms, fn) => { timers.push({ at: now + ms, seq: seq++, fn }); };
  const info = {
    Terrains: table("TerrainType", TERRAINS.map((TerrainType) => ({ TerrainType }))),
    Features: table("FeatureType", FEATURES),
    Feature_NaturalWonders: [],
    Districts: table("DistrictType", DISTRICTS.map((DistrictType) => ({ DistrictType }))),
    Ages: table("AgeType", AGES.map((AgeType, ChronologyIndex) => ({ AgeType, ChronologyIndex }))),
    Constructibles: table("ConstructibleType", CONSTRUCTIBLES.map(([ConstructibleType, ConstructibleClass, Age]) =>
      ({ ConstructibleType, ConstructibleClass, Age, Name: "LOC_" + ConstructibleType }))),
    Types: table("Type", CONSTRUCTIBLES.map(([Type]) => ({ Type, Hash: hashOf(Type) }))),
    Buildings: table("ConstructibleType", []),
    TypeTags: table("Type", [{ Type: "BUILDING_PALACE", Tag: "AGELESS" }]),
    Constructible_RequiredFeatures: table("ConstructibleType", []),
    Constructible_RequiredFeatureClasses: table("ConstructibleType", []),
    Constructible_ValidTerrains: table("ConstructibleType", []),
    Constructible_ValidBiomes: table("ConstructibleType", []),
    Constructible_ValidFeatures: table("ConstructibleType", []),
    Constructible_ValidResources: table("ConstructibleType", []),
    ProgressionTreeNodes: table("ProgressionTreeNodeType", [{ ProgressionTreeNodeType: "NODE_TECH_EX_SHIPBUILDING",
      Name: "LOC_SHIPBUILDING" }]),
    ProgressionTreeNodeUnlocks: table("TargetType", [{ TargetType: "BUILDING_CANAL_EXPLORATION",
      ProgressionTreeNodeType: "NODE_TECH_EX_SHIPBUILDING" }]),
  };
  const typeName = (i) => info.Constructibles.lookup(i).ConstructibleType;
  const typeIndex = (t) => info.Constructibles.lookup(t).$index;
  const findBuild = (id) => {
    for (let i = 0; i < tiles.length; i++) {
      const k = tiles[i].builds.findIndex((b) => b.id === id);
      if (k >= 0) return { tile: tiles[i], k };
    }
    return null;
  };
  const config = new Map(); const user = { autoSaveFrequency: options.autosave ?? 1, autoSaveKeepCount: 10 };
  const handlers = new Map();
  const refused = new Set(options.refused || []);

  const request = (who) => (pid, op, a) => {
    note(`${who}.sendRequest ${pid} ${op} ${J(a)}`);
    if (op === "DESTROY_ELEMENT" && a.Kind === "CONSTRUCTIBLE") later(150, () => {
      const f = findBuild(a.LocalID); if (f) f.tile.builds.splice(f.k, 1);
    });
    if (op === "DESTROY_ELEMENT" && a.Kind === "DISTRICT") later(150, () => {
      for (const t of tiles) if (t.district && t.district.id === a.LocalID) { t.district = null; t.builds = []; t.owner = -1; t.city = null; }
    });
    if (op === "CREATE_ELEMENT" && a.Kind === "CONSTRUCTIBLE" && !refused.has(a.Type)) later(150, () => {
      const t = at(a.Location.x, a.Location.y);
      if (info.Constructibles.lookup(a.Type).ConstructibleClass === "IMPROVEMENT")
        t.builds = t.builds.filter((b) => info.Constructibles.lookup(b.type).ConstructibleClass !== "IMPROVEMENT");
      t.builds.push({ type: a.Type, owner: a.Owner, id: nextId++, complete: true });
    });
    if (op === "CREATE_ELEMENT" && a.Kind === "DISTRICT" && !refused.has(a.Type)) later(150, () => {
      const t = at(a.Location.x, a.Location.y);
      t.district = { type: a.Type, id: nextId++, city: refused.has("PARENT") ? null : a.Parent ?? null };
      if (t.owner < 0) t.owner = a.Owner;
    });
    return true;
  };
  const plotOf = (l) => l.y * W + l.x;
  const locOf = (i) => ({ x: i % W, y: Math.floor(i / W) });

  /** A city operation host: canStart from the scenario's verdict, sendRequest recorded and applied. */
  const host = (name, verdict, onSend) => ({
    canStart: (city, type, args, _x) => {
      note(`${name}.canStart ${J(city)} ${type} ${J(args)}`);
      return verdict(city != null && typeof city === "object" ? city.id : city, type, args || {});
    },
    sendRequest: (cityID, type, args) => { note(`${name}.sendRequest ${cityID} ${type} ${J(args)}`); return onSend(cityID, type, args); },
    canStartQuery: (cityID, type, query) => [{ index: typeIndex("BUILDING_MARKET"), result: { Success: true } }]
      .concat(options.queryHasCanal ? [{ index: typeIndex("BUILDING_CANAL_EXPLORATION"), result: { Success: false } }] : []),
  });
  const verdicts = { build: options.build || (() => ({ Success: false })), buy: options.buy || (() => ({ Success: false })) };
  const send = (purchase) => (city, type, args) => {
    const cityID = city != null && typeof city === "object" ? city.id : city;
    if (type === 3) { // EXPAND
      later(200, () => {
        const t = at(args.X, args.Y);
        t.district = { type: "DISTRICT_RURAL", id: nextId++, city: cityID };
        t.builds.push({ type: "IMPROVEMENT_FISHING_BOAT", owner: 0, id: nextId++, complete: true });
      });
      return true;
    }
    if (options.forwardIgnored) return true;
    const def = info.Constructibles.lookup(args.ConstructibleType);
    if (!def || args.InsertMode != null) {
      const q = cities.get(cityID).queue;
      if (args.InsertMode === "RemoveAt") q.splice(args.QueueLocation, 1);
      else if (args.InsertMode === "MoveTo") q.splice(args.QueueDestinationLocation, 0, ...q.splice(args.QueueSourceLocation, 1));
      else if (def) q.push({ constructibleType: def.$index, location: { x: args.X, y: args.Y } });
      return true;
    }
    later(205, () => {
      if (purchase) at(args.X, args.Y).builds.push({ type: def.ConstructibleType, owner: 0, id: nextId++, complete: true });
      else cities.get(cityID).queue.push({ constructibleType: def.$index, location: { x: args.X, y: args.Y } });
    });
    return true;
  };

  const city = (id, owner, cx, cy) => {
    const c = { id, owner, location: { x: cx, y: cy }, queue: [], isCapital: id === 1,
      getPurchasedPlots: () => tiles.map((t, i) => i).filter((i) => tiles[i].city === id),
      purchasePlot: (l) => { note(`Cities.purchasePlot ${id} ${J(l)}`); later(100, () => { const t = at(l.x, l.y); t.owner = owner; t.city = id; }); },
      addRuralPopulation: (n) => note(`Cities.addRuralPopulation ${id} ${n}`),
      BuildQueue: { getQueue: () => c.queue.slice() },
      Gold: { getBuildingPurchaseCost: () => options.price ?? 400 },
    };
    cities.set(id, c);
    return c;
  };
  city(1, 0, ...(() => { const i = tiles.findIndex((t) => t.district && t.district.type === "DISTRICT_CITY_CENTER"); return [i % W, Math.floor(i / W)]; })());
  for (const pid of [0, 1]) players.set(pid, { id: pid, isAlive: true, isMajor: true, isHuman: pid === 0,
    isTurnActive: options.turnActive ?? true, gold: options.gold ?? 5000, techs: new Set(options.techs || []) });

  const G = {
    GameplayMap: {
      getGridWidth: () => W, getGridHeight: () => H,
      getIndexFromLocation: plotOf, getLocationFromIndex: locOf,
      getTerrainType: (x, y) => TERRAINS.indexOf(at(x, y).terrain),
      getFeatureType: (x, y) => { const f = at(x, y).feature; return f ? FEATURES.findIndex((r) => r.FeatureType === f) : -1; },
      getResourceType: (x, y) => (at(x, y).resource ? 0 : -1),
      isWater: (x, y) => at(x, y).terrain === "TERRAIN_COAST",
      isNavigableRiver: () => false,
      getAreaId: (x, y) => at(x, y).area,
      isCliffCrossing: (x, y, d) => !!(at(x, y).cliffs || []).includes(d),
      getAdjacentPlotLocation: (l, d) => { const n = step(l.x, l.y, d); return at(n.x, n.y) ? n : { x: -1, y: -1 }; },
      getPlotIndicesInRadius: (x, y) => [plotOf({ x, y }), ...[0, 1, 2, 3, 4, 5].map((d) => step(x, y, d))
        .filter((n) => at(n.x, n.y)).map(plotOf)],
      getPlotDistance: (x1, y1, x2, y2) => { const a = cube(x1, y1), b = cube(x2, y2); return Math.max(...a.map((v, i) => Math.abs(v - b[i]))); },
      getOwner: (x, y) => at(x, y).owner,
      getOwningCityFromXY: (x, y) => (at(x, y).city ? { id: at(x, y).city, owner: at(x, y).owner } : null),
    },
    GameInfo: info,
    Game: {
      get age() { return options.age ?? 1; }, get turn() { return options.turn ?? 10; },
      PlayerOperations: { sendRequest: request("PlayerOperations"), canStart: () => ({ Success: false }) },
      CityOperations: host("CityOperations", verdicts.build, send(false)),
      CityCommands: host("CityCommands", verdicts.buy, send(true)),
      UnitOperations: { sendRequest: (u, t, a) => { note(`UnitOperations.sendRequest ${J(u)} ${t} ${J(a)}`); return true; } },
      AgeProgressManager: { isExtendedGame: false, get isAgeOver() { return !!options.ageOver; } },
    },
    GameContext: { get localPlayerID() { return 0; } },
    Players: {
      get: (pid) => {
        const p = players.get(pid); if (!p) return null;
        return { isAlive: p.isAlive, isMajor: p.isMajor, isHuman: p.isHuman, isTurnActive: p.isTurnActive,
          Cities: { getCities: () => [...cities.values()].filter((c) => c.owner === pid) },
          Techs: { isNodeUnlocked: (n) => p.techs.has(n) }, Treasury: { get goldBalance() { return p.gold; } } };
      },
      grantYield: (pid, y, n) => { note(`Players.grantYield ${pid} ${y} ${n}`); players.get(pid).gold += n; },
    },
    // the game hands out a city as an id object, which Cities.get takes as it takes a number
    Cities: { get: (id) => cities.get(id != null && typeof id === "object" ? id.id : id) || null },
    Districts: {
      getAtLocation: (l) => { const d = at(l.x, l.y).district; return d ? { type: info.Districts.lookup(d.type).$index, cityId: d.city == null ? null : { id: d.city } } : null; },
      getIdAtLocation: (l) => { const d = at(l.x, l.y).district; return d ? { owner: at(l.x, l.y).owner, id: d.id } : null; },
    },
    MapConstructibles: { getConstructibles: (x, y) => at(x, y).builds.map((b) => ({ id: b.id })) },
    Constructibles: { getByComponentID: (c) => { const f = findBuild(c.id); const b = f.tile.builds[f.k]; return { type: typeIndex(b.type), owner: b.owner, localId: b.id, complete: b.complete }; } },
    MapUnits: { getUnits: (x, y) => at(x, y).units },
    Units: { get: () => null, getPathTo: () => ({ plots: [] }) },
    WorldBuilder: {
      startBlock: () => note("WorldBuilder.startBlock"), endBlock: () => note("WorldBuilder.endBlock"),
      MapPlots: {
        setTerrain: (t, l) => { note(`WorldBuilder.setTerrain ${TERRAINS[t]} ${J({ x: l.x, y: l.y })}`); later(200, () => { at(l.x, l.y).terrain = TERRAINS[t]; }); },
        setFeature: (f, l) => { note(`WorldBuilder.setFeature ${f < 0 ? "none" : FEATURES[f].FeatureType} ${J({ x: l.x, y: l.y })}`); later(100, () => { at(l.x, l.y).feature = f < 0 ? null : FEATURES[f].FeatureType; }); },
      },
    },
    WorldUI: {
      createModelGroup: (name) => { note(`WorldUI.createModelGroup ${name}`); return {
        addModelAtPlot: (asset) => note(`  model ${asset}`), addVFXAtPlot: (v) => note(`  vfx ${v}`),
        clear: () => note(`  clear ${name}`), destroy: () => note(`  destroy ${name}`) }; },
    },
    PlacementMode: { TERRAIN: 1 },
    Configuration: {
      getGame: () => ({ getValue: (k) => config.get(k) ?? null, isNetworkMultiplayer: !!options.multiplayer }),
      editGame: () => ({ setValue: (k, v) => { note(`Configuration.setValue ${k} ${v}`); config.set(k, v); } }),
      getUser: () => ({ get autoSaveFrequency() { return user.autoSaveFrequency; }, get autoSaveKeepCount() { return user.autoSaveKeepCount; },
        setAutoSaveFrequency: (v) => { note(`Configuration.setAutoSaveFrequency ${v}`); user.autoSaveFrequency = v; } }),
    },
    Network: {
      saveGame: (p) => { note(`Network.saveGame ${J(p)}`); later(300, () => fire("StartSaveRequest", {})); later(900, () => fire("SaveComplete", {})); return true; },
      loadGame: (p) => { note(`Network.loadGame ${J(p)}`); return true; },
      deleteGame: (p) => { note(`Network.deleteGame ${J(p)}`); return true; },
    },
    engine: {
      on: (e, f) => { note(`engine.on ${e}`); handlers.set(e, f); }, off: (e) => { note(`engine.off ${e}`); handlers.delete(e); },
    },
    UI: { getGameLoadingState: () => 8 },
    UIGameLoadingState: { GameStarted: 8 },
    Locale: { compose: (...a) => a.join(" ") },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { querySelectorAll: () => [] },
    FeatureTypes: { NO_FEATURE: -1 }, ResourceTypes: { NO_RESOURCE: -1 },
    DirectionTypes: Object.fromEntries(RING.map((d, i) => [d, i])),
    CityOperationTypes: { BUILD: 1 }, CityCommandTypes: { PURCHASE: 2, EXPAND: 3 },
    CityOperationsParametersValues: { RemoveAt: "RemoveAt", MoveTo: "MoveTo" },
    CityQueryType: { Constructible: 7 }, YieldTypes: { YIELD_GOLD: "YIELD_GOLD" },
    UnitOperationTypes: { MOVE_TO: "MOVE_TO" },
    SaveLocations: { LOCAL_STORAGE: 1 }, SaveLocationCategories: { AUTOSAVE: 2 }, SaveTypes: { SINGLE_PLAYER: 3 },
    SaveFileTypes: { GAME_STATE: 4 }, ServerType: { SERVER_TYPE_NONE: 0 },
  };
  function fire(e, d) { note(`event ${e}`); const f = handlers.get(e); if (f) f(d); }

  /** Make this the game the script sees: globals, the virtual clock, and the log into the trace. */
  function install() {
    Object.assign(globalThis, G);
    globalThis.setTimeout = (fn, ms) => { later(Math.max(0, ms || 0), fn); return seq; };
    globalThis.clearTimeout = () => {};
    Date.now = () => now;
    console.error = (m) => note(`log ${m}`);
  }
  /** Fire timers in order until none are left or `limit` ms have passed, draining microtasks between them. */
  async function run(limit = 120000) {
    const drain = () => new Promise((r) => setImmediate(r));
    await drain(); await drain();
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = timers.shift();
      if (t.at > limit) { note(`(stopped with ${timers.length + 1} timer(s) left)`); break; }
      now = t.at; t.fn();
      await drain(); await drain();
    }
  }
  const tile = (x, y, props) => {
    const t = at(x, y);
    if (props.district) { t.district = { type: props.district, id: nextId++, city: props.cityless ? null : 1 }; t.owner = 0; t.city = 1; }
    if (props.own) { t.owner = 0; t.city = 1; }
    for (const b of props.builds || []) t.builds.push({ type: b.type || b, owner: b.owner ?? 0, id: nextId++, complete: b.complete ?? true });
    if (props.terrain) t.terrain = props.terrain;
    if (props.feature) t.feature = props.feature;
    if (props.units) t.units = props.units;
    if (props.cliffs) t.cliffs = props.cliffs;
  };
  /** The world as it ends: every tile that has anything on it, the queues, the save's records, gold. */
  function state() {
    const out = [];
    tiles.forEach((t, i) => {
      if (!t.district && !t.builds.length && !t.feature) return;
      const l = locOf(i);
      out.push(`${l.x},${l.y} ${t.terrain.replace("TERRAIN_", "")} owner=${t.owner} city=${t.city} ` +
        `district=${t.district ? t.district.type.replace("DISTRICT_", "") + (t.district.city == null ? "(no city)" : "") : "-"} ` +
        `feature=${t.feature || "-"} builds=${t.builds.map((b) => b.type + (b.complete ? "" : "*")).join(",") || "-"}`);
    });
    for (const c of cities.values()) out.push(`city ${c.id} queue=${J(c.queue)}`);
    for (const [k, v] of [...config.entries()].sort()) out.push(`config ${k}=${v}`);
    for (const [pid, p] of players) out.push(`player ${pid} gold=${p.gold}`);
    out.push(`autosave frequency=${user.autoSaveFrequency}`);
    return out;
  }
  return { addCity: city, install, run, tile, trace, state, fire, config, cities, players, plotOf, locOf, typeIndex, typeName,
    hash: hashOf, get now() { return now; }, queue: (cityId, type, x, y) => cities.get(cityId).queue.push({ constructibleType: typeIndex(type), location: { x, y } }) };
}
