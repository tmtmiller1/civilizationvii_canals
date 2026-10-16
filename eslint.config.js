// Dev-only ESLint flat config: the size limits the other tower mods use, plus the
// usual correctness rules. Not shipped in release artifacts.

const ENGINE_GLOBALS = {
  Game: "readonly",
  GameContext: "readonly",
  Online: "readonly",
  Players: "readonly",
  GameInfo: "readonly",
  GameplayMap: "readonly",
  Configuration: "readonly",
  Locale: "readonly",
  engine: "readonly",
  Database: "readonly",
  Controls: "readonly",
  Cities: "readonly",
  Districts: "readonly",
  ComponentID: "readonly",
  Modding: "readonly",
  UI: "readonly",
  WorldUI: "readonly",
  Loading: "readonly",
  InputActionStatuses: "readonly",
  SpriteMode: "readonly",
  RiverTypes: "readonly",
  // Engine surfaces the canal build path uses: plot retyping, district placement
  // and the unit sweep that clears a tile before it is rebuilt as water.
  Constructibles: "readonly",
  MapConstructibles: "readonly",
  Units: "readonly",
  MapUnits: "readonly",
  FeatureTypes: "readonly",
  DirectionTypes: "readonly",
  PlacementMode: "readonly",
  CityOperationTypes: "readonly",
  CityOperationsParametersValues: "readonly",
  CityCommandTypes: "readonly",
  CityQueryType: "readonly",
  ResourceTypes: "readonly",
  UnitOperationTypes: "readonly",
  WorldBuilder: "readonly",
  // the save call, wrapped so canals are land before a save is written
  Network: "readonly",
  UIGameLoadingState: "readonly",
  SaveLocations: "readonly",
  SaveLocationCategories: "readonly",
  SaveTypes: "readonly",
  ServerType: "readonly",
  SaveFileTypes: "readonly",
  YieldTypes: "readonly"
};

const BROWSER_GLOBALS = {
  window: "readonly",
  document: "readonly",
  console: "readonly",
  localStorage: "readonly",
  globalThis: "readonly",
  structuredClone: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  MutationObserver: "readonly",
  CustomEvent: "readonly"
};

export default [
  // Tower Settings Keeper, copied unchanged from its own repo; it is linted and tested there.
  { ignores: ["ui/settings-keeper.js"] },
  {
    files: ["ui/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...ENGINE_GLOBALS, ...BROWSER_GLOBALS }
    },
    rules: {
      // Size and shape rules still only warn. What's over them drives the engine through
      // steps whose order is watched behaviour: the async openings and repairs (openCanal,
      // placeCanal, settleCanalTile, healDistrict, repairCitylessDistricts and the rest of
      // canals-repair.js, putFeature and syncSites), sweep, the canStart, canStartQuery and
      // sendRequest wraps, install and uninstall, and the parked ship limit (wrapUnitSend).
      // Each is split on its own and watched in a game (docs/split-plan.md, step 4); then
      // these go back to "error" to match the other tower mods.
      complexity: ["warn", 10],
      "max-statements": ["warn", 18],
      "max-depth": ["warn", 4],
      "max-lines-per-function": [
        "warn",
        { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }
      ],
      // every file has been under it since canals.js was split into modules
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      // the rest are errors, as in the other tower mods
      "max-len": [
        "error",
        {
          code: 120,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true
        }
      ],
      "max-params": ["error", 5],
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      eqeqeq: ["error", "always", { null: "ignore" }]
    }
  }
];
