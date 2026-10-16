// queue-window-probe.js - the gap compatibility.md section 10 leaves: a Canal ordered by production on an urban tile
// with old buildings, and another building's placement opened in the same city before the Canal shows on the map.
// Eval into a lab game (Exploration, the Canal's tech known), then call QW.step(name) and read QW.out. Steps:
//   QW.step("find")    - the local player's city with an urban site the mod offers, and that site
//   QW.step("order")   - the Canal into production on that site, through the mod's wrapped BUILD, as the screen does
//   QW.step("offered") - which tiles the engine offers a Wonder and a plain building in that city now
// Then finish the Canal (tower-bench do complete) and run "offered" again.
(() => {
  const safe = (f, d = null) => { try { return f(); } catch (e) { return d; } };
  const M = () => globalThis.__canals;
  const local = () => GameContext.localPlayerID;
  const locOf = (i) => GameplayMap.getLocationFromIndex(i);
  const key = (l) => `${l.x},${l.y}`;
  const canal = () => GameInfo.Constructibles.find((c) => /^BUILDING_CANAL/.test(c.ConstructibleType) && c.Age === GameInfo.Ages.lookup(Game.age).AgeType)
    || GameInfo.Constructibles.lookup("BUILDING_CANAL_EXPLORATION");
  const typesAt = (l) => safe(() => (MapConstructibles.getConstructibles(l.x, l.y) || []).map((id) => {
    const c = Constructibles.getByComponentID(id); const row = GameInfo.Constructibles.lookup(c.type);
    return `${row.ConstructibleType}${c.complete ? "" : "(unfinished)"}`;
  }), []);
  const district = (l) => safe(() => { const d = Districts.getAtLocation(l); return d ? GameInfo.Districts.lookup(d.type).DistrictType : null; });
  const state = { out: {} };
  function plotsFor(cid, type) {
    const row = GameInfo.Constructibles.lookup(type);
    if (!row) return { type, missing: true };
    const r = safe(() => Game.CityOperations.canStart(cid, CityOperationTypes.BUILD, { ConstructibleType: row.$index }, false), null);
    if (!r) return { type, none: true };
    const plots = (r.Plots || []).map(locOf).map(key), expand = (r.ExpandUrbanPlots || []).map(locOf).map(key);
    return { type, success: r.Success, plots, expand };
  }
  const steps = {
    find() {
      const p = Players.get(local());
      for (const c of p.Cities.getCities()) {
        const sites = safe(() => M().eligiblePlots(c.id, false, false), []).map((i) => typeof i === "number" ? locOf(i) : i);
        const urban = sites.filter((l) => district(l) === "DISTRICT_URBAN" && typesAt(l).length);
        if (urban.length) {
          state.cid = c.id; state.site = urban[0];
          return { city: Locale.compose(c.name), cid: c.id.id, site: key(urban[0]), holds: typesAt(urban[0]), urbanSites: urban.map(key), allSites: sites.length };
        }
      }
      return { err: "no urban site with buildings in any city", cities: p.Cities.getCities().map((c) => Locale.compose(c.name)) };
    },
    order() {
      const def = canal();
      const args = { ConstructibleType: def.$index, X: state.site.x, Y: state.site.y };
      const can = safe(() => Game.CityOperations.canStart(state.cid, CityOperationTypes.BUILD, args, false), null);
      safe(() => Game.CityOperations.sendRequest(state.cid, CityOperationTypes.BUILD, args));
      return { canal: def.ConstructibleType, can: can && { Success: can.Success, FailureReasons: can.FailureReasons }, site: key(state.site) };
    },
    offered() {
      const c = Cities.get(state.cid);
      const queue = safe(() => c.BuildQueue.getQueue().map((q) => GameInfo.Constructibles.lookup(q.constructibleType)?.ConstructibleType ?? q.type), []);
      const wonders = GameInfo.Constructibles.filter((r) => r.ConstructibleClass === "WONDER" && r.Age === GameInfo.Ages.lookup(Game.age).AgeType);
      const wonder = wonders.map((w) => plotsFor(state.cid, w.ConstructibleType)).find((x) => x.success) || null;
      const buildings = GameInfo.Constructibles.filter((r) => r.ConstructibleClass === "BUILDING" && r.Age === GameInfo.Ages.lookup(Game.age).AgeType && !/CANAL/.test(r.ConstructibleType));
      const building = buildings.map((b) => plotsFor(state.cid, b.ConstructibleType)).find((x) => x.success && x.plots.length) || null;
      const s = key(state.site);
      return { turn: Game.turn, site: s, siteHolds: typesAt(state.site), siteDistrict: district(state.site), isCanal: safe(() => M().canalIndexes.has(GameplayMap.getIndexFromLocation(state.site))), queue,
        wonder: wonder && { type: wonder.type, siteOffered: wonder.plots.includes(s) || wonder.expand.includes(s), plots: wonder.plots.length, expand: wonder.expand.length },
        building: building && { type: building.type, siteOffered: building.plots.includes(s) || building.expand.includes(s), plots: building.plots.length } };
    },
  };
  globalThis.QW = { out: state.out, step(name) { try { state.out[name] = steps[name](); } catch (e) { state.out[name] = { err: String(e && e.stack || e) }; } return JSON.stringify(state.out[name]); } };
  return "QW ready";
})();
