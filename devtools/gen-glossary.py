#!/usr/bin/env python3
"""Build devtools/glossary/<locale>.json: the game's own translation of every game term the mod's English uses.

Reads the base game's English text and its l10n files for each language, and keeps the tags whose English is one of
TERMS (exact match, case-insensitive), so translators use the words the game itself uses ("Culture", "Influence",
"Society", "Expedition Base", ...). Run from the mod root: python3 devtools/gen-glossary.py
(Ported from National Park with the Canals term list.)
"""
import glob
import json
import os
import re

ROOT = os.path.expanduser("~/Library/Application Support/Steam/steamapps/common/Sid Meier's Civilization VII/"
                          "CivilizationVII.app/Contents/Resources/Base/modules")
LOCALES = {"de_de": "de_DE", "es_es": "es_ES", "fr_fr": "fr_FR", "it_it": "it_IT", "ja_jp": "ja_JP", "ko_kr": "ko_KR",
           "pl_pl": "pl_PL", "pt_br": "pt_BR", "ru_ru": "ru_RU", "zh_cn": "zh_Hans_CN", "zh_hk": "zh_Hant_HK"}

TERMS = [
    "Engineering", "Shipbuilding", "Industrialization", "Antiquity", "Exploration", "Modern", "Antiquity Age",
    "Exploration Age", "Modern Age", "Food", "Gold", "Production", "City", "Town", "Settlement", "Settlements",
    "City Center", "Town Center", "Improvement", "Improvements", "District", "Urban District", "Rural District",
    "Coast", "Lake", "Ocean", "Sea", "River", "Navigable River", "Hills", "Flat", "Cliffs", "Ice", "Thera",
    "Natural Wonder", "Resource", "Resources", "Fishing Boat", "Citizen", "Population", "Purchase", "Multiplayer",
    "Single Player", "Civilopedia", "Game Concepts", "Later", "Building", "Buildings", "Naval", "Embarked",
    "Embark", "Production Queue", "Autosave", "Autosaves", "Reload", "Basics", "Placement", "Yields", "Ships",
]

EN_ROW = re.compile(r'<(?:Row|Replace)\s+Tag="([A-Z0-9_]+)"[^>]*>\s*<Text>([^<]*)</Text>', re.S)


def english():
    out = {}
    for p in glob.glob(os.path.join(ROOT, "*", "text", "en_us", "*.xml")):
        for tag, text in EN_ROW.findall(open(p, encoding="utf-8-sig").read()):
            out.setdefault(tag, text.strip())
    return out


def localized(lang):
    out = {}
    for p in glob.glob(os.path.join(ROOT, "*", "l10n", f"{lang}*.xml")):
        for tag, text in EN_ROW.findall(open(p, encoding="utf-8-sig").read()):
            out.setdefault(tag, text.strip())
    return out


if __name__ == "__main__":
    en = english()
    wanted = {t.lower(): t for t in TERMS}
    tags = {}
    for tag, text in en.items():
        key = text.lower()
        if key in wanted and not tag.startswith(("LOC_TUTORIAL", "LOC_ACHIEVEMENT")):
            tags.setdefault(wanted[key], []).append(tag)
    os.makedirs("devtools/glossary", exist_ok=True)
    for folder, lang in LOCALES.items():
        loc = localized(lang)
        gloss = {}
        for term, ts in sorted(tags.items()):
            seen = []
            for t in ts:
                v = loc.get(t)
                if v and v not in seen:
                    seen.append(v)
            if seen:
                gloss[term] = seen[:3]
        with open(f"devtools/glossary/{folder}.json", "w", encoding="utf-8") as f:
            json.dump(gloss, f, ensure_ascii=False, indent=1)
        print(folder, len(gloss), "terms")
