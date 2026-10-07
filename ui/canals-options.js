// The mod's row in Options > Add-ons, which picks the canal rules in play.
//
// "By age" is the mod as it has always been; "One-tile canals" swaps in the one Canal that is the same in every age
// (see canals-settings.js and ui/canals.js). Loaded in the main menu, where the choice is the default for new games,
// and in a game, where it changes that game's rules from then on. Cancel puts back what was there on opening.

import { CategoryType, OptionType, Options } from "/core/ui/options/model-options.js";
import { CategoryData } from "/core/ui/options/options-helpers.js";
import { MODES, getMode, setMode } from "/tower-canals/ui/canals-settings.js";

// The shared "Mods" category, created the same way Tower's other mods and the community's create it. This also runs
// in the main menu, where a throw would take the menu down, so any failure only leaves the row out.
try {
  if (!CategoryType.Mods) CategoryType.Mods = "mods";
  if (!CategoryData[CategoryType.Mods]) {
    CategoryData[CategoryType.Mods] = {
      title: "LOC_UI_CONTENT_MGR_SUBTITLE",
      description: "LOC_UI_CONTENT_MGR_SUBTITLE_DESCRIPTION"
    };
  }
  Options.addInitCallback(() => {
    Options.addOption({
      category: CategoryType.Mods,
      // becomes the header key LOC_OPTIONS_GROUP_CANALS
      group: "canals",
      type: OptionType.Dropdown,
      id: "canals-mode",
      label: "LOC_CANALS_OPTION_MODE",
      description: "LOC_CANALS_OPTION_MODE_DESCRIPTION",
      dropdownItems: [{ label: "LOC_CANALS_OPTION_MODE_AGES" }, { label: "LOC_CANALS_OPTION_MODE_ONE_TILE" }],
      initListener: (/** @type {*} */ info) => {
        info.selectedItemIndex = Math.max(0, MODES.indexOf(getMode()));
        info.valueOnOpen = info.selectedItemIndex;
      },
      updateListener: (/** @type {*} */ info, /** @type {number} */ index) => {
        info.selectedItemIndex = index;
        setMode(MODES[index] || MODES[0]);
      },
      restoreListener: (/** @type {*} */ info) => setMode(MODES[info.valueOnOpen] || MODES[0])
    });
  });
} catch (e) {
  console.error("[Canals] Options row not added: " + e);
}
