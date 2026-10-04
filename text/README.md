# Translating Canals (`text/`)

Every string a player sees in Canals is a `LOC_*` tag defined here and looked up by the game at run time. The script
sets no display text of its own, so a translation needs no code change: add the language's file here and two lines to
the modinfo.

## Files

| File | Contents |
| --- | --- |
| `en_us/CanalsText.xml` | The source of truth: the mod's name and description, the Canal buildings, the placement messages, the notices, the Options row and the Civilopedia pages (75 tags). |
| `<lang>/CanalsText.xml` | The same tags in one language. |

All eleven languages below ship as machine translations (2026-10-01) that use the game's own words for its terms,
taken from the game's l10n files by `devtools/gen-glossary.py` into `devtools/glossary/`. To correct one, edit its
`<Text>`; to change the English, edit the English and update every language.

## Two file shapes

English uses an `EnglishText` block with `Row`:

```xml
<Database>
    <EnglishText>
        <Row Tag="LOC_CANALS_MOD_NAME"><Text>Canals</Text></Row>
    </EnglishText>
</Database>
```

Every other language uses a `LocalizedText` block with `Replace` and a `Language` attribute:

```xml
<Database>
    <LocalizedText>
        <Replace Tag="LOC_CANALS_MOD_NAME" Language="de_DE"><Text>Kanäle</Text></Replace>
    </LocalizedText>
</Database>
```

**The `Language` value is not the folder name.** Use these exactly:

| Folder | `Language=` | Folder | `Language=` |
| --- | --- | --- | --- |
| `de_de` | `de_DE` | `pl_pl` | `pl_PL` |
| `es_es` | `es_ES` | `pt_br` | `pt_BR` |
| `fr_fr` | `fr_FR` | `ru_ru` | `ru_RU` |
| `it_it` | `it_IT` | `zh_cn` | `zh_Hans_CN` |
| `ja_jp` | `ja_JP` | `ko_kr` | `ko_KR` |
| `zh_hk` | `zh_Hant_HK` (Traditional Chinese) | | |

## Registering a language in the modinfo

Each file is listed in both action groups that load text, `canals-shell` (the Additional Content list) and
`canals-game`, with a `locale` attribute:

```xml
<Item locale="de_DE">text/de_de/CanalsText.xml</Item>
```

## Rules

- **Every tag, in every language.** The game loads one language at a time, so a tag missing from a translation shows
  as the raw `LOC_...` key to that language's players.
- **Keep the placeholders, icons and markup.** `{1_Canal}` and `{2_Tech}` are filled in by the game; keep each one, in
  whatever position the language needs. Keep every `[icon:YIELD_...]`, `[TIP:...]...[/TIP]`, `[N]`, `[B]...[/B]` and
  `[BLIST][LI]...[/LIST]`.
- **Page titles stay short.** The Civilopedia sidebar cuts titles longer than about 24 characters.
- **No duplicate tags.** A tag defined twice in one file makes the game drop the whole file.

## Checking a translation

`npm run i18n` (`tests/i18n.test.mjs`) fails when a translation is missing a tag or has an extra one, uses the wrong
`Language`, uses `Row` instead of `Replace`, defines a tag twice, changes the placeholders or markup the English has,
or is not registered in both modinfo groups.
