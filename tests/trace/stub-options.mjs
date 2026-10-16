// stub-options.mjs - the game's Options model, for the sequence traces: addOption is recorded, data holds nothing.
export const Options = {
  data: new Map(),
  addOption(info) { globalThis.__traceNote(`Options.addOption ${info && info.id}`); },
};
