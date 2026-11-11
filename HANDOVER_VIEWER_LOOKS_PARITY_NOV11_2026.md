# HANDOVER — the viewer's look drawing, made ready on today's main (2026-11-11)

## For Mike

- **Ready to go live? Code-ready, not eyes-ready.** Branch `looks/viewer-parity-nov11` = today's main + the 11-03 look branch + a fresh palette copy. It loads cleanly in node checks; nobody has looked at it in a browser since the merge. Your 5-minute test below is the green light.
- **What a visitor would see change:** a world exported in Saturday Cartoon, Toytown or Golden Storybook gets its outlines, banded shading and colour grade, and its water takes the look's colour (today all three draw as Natural). Every world opened from a link also opens on the **table (the diorama)** first, with "Dive in", and gets a **"Share card · 4 looks"** button. Those two are not looks; say if you want them held back.
- **Unchanged:** a natural world (no look tag) and a baked world (Sugar & Snow, Looking-Glass, Felt/Clay/Wax) draw their land, water and light exactly as main does. Only the table opening and the new button differ (see §3).
- **Not done (needs the client or a bigger build):** Sugar & Snow water is still open water, not ice. The look's path and snow colours are not drawn because the baked ground does not carry them. Saturday Cartoon's crease lines and the look's water "character" (shore rim, soft highlight, calm) are missing too.
- **What I could not check:** pixels. I ran no browser. Nothing here says how anything looks.
- **The 5-minute test:** in Unity, glTF-export your small 11-08 world (Serene Grass, Solo) **twice: once in Saturday Cartoon and once in Sugar & Snow**. Check out this branch in `thalyn-world`, run `python -m http.server 8000` in that folder, and open `http://localhost:8000/viewer/`. Drop each `single/World_web.glb` on the page with the console open (F12). Then drop the same files on the live viewer.
  - **Saturday Cartoon:** the console should print `[look] … render row 'saturdaycartoon' … applied: water N material(s), render layer`. On a laptop or desktop you should see black outlines, flat banded light and stronger colour, with water bluer than on the live site. The live site shows it plain.
  - **Sugar & Snow:** the console should print `baked 'sugar_snow' - no live layer`. It should look the same as on the live site, open water included.
  - If both pass, it is green.

---

## 1 · What was done

| # | Commit | What |
|---|---|---|
| 1 | `be09053` | merge `origin/looks/viewer-look-tag` (17 commits, base `6cfa05a`) into a branch cut from `origin/main` @ `46a6b4c` (14 commits ahead of that base) |
| 2 | `a7687c7` | re-copy `viewer/looks/LookPalettes.json` verbatim from the client tip `integration/return-oct2026` @ `489632a0` (`cmp` identical). Rows went from 6 to 10 (+ felt, clay, wax, sugar_snow). Also new: `path` rows, water `rimM/specPower/specIntensity/calm`, pastelclay sky `cloudMip/cloudEdge`, storybook `shadowStrengthMul`, lookingglass `tagGlow` |
| 3 | `0c7894c` | `viewer/looks/thalyn-look-parity.test.mjs` runs the 3 hand-written extras blocks through the pure functions (ALL PASS 26) |
| 4 | (this file) | handover |

No JS file's behaviour was changed apart from the merge resolution in `viewer/index.html`. No new libraries or CDN URLs. `three@0.160.0` comes through the existing import map (`viewer/index.html:272-278`).

## 2 · Conflicts (all in `viewer/index.html`) and how each was resolved, both sides kept

| Where (merged line) | main | look branch | Resolution |
|---|---|---|---|
| world panel buttons `:189-190` | `b-report-w` Report this world (A14134) | `b-card` Share card · 4 looks | both buttons, Share card first |
| on load `:994-995` | show share/together + the Report rule (shared-world URLs only) | show share/together/**card** | card shown + main's Report rule line kept verbatim |
| after framing `:1006-1007` | `if (card) card.worldReady();` (Christmas card A13681) | `openDiorama();` | both; the diorama opens **only when no Christmas card is active** (`!(card && card.active)`), because a card owns its own opening (cover, then globe). A table under a snow globe would fight it. This is my one judgement call |
| frame loop `:1600-1602` | `card.tick(dt)` + "no orbit while the card flies" | `diorama.tick(dt)` + plain orbit | `card.tick`, then `diorama.tick`, then main's orbit rule kept |

Everything else auto-merged. I read the full merged diff: the `apply()` → `atmoState()` split (`:378-405`), the zone-sky code (`:414-457`), the look block (`:572-598`), clear/reset hooks (`:738-743`, `:769-771`), ingest layer tags (`:837-839`), `lastFrame` (`:893`), diorama/share-card wiring (`:1120-1224`), and the pass creation (`:1295-1298`). `node --check` passes on every `viewer/*.js`, on both test files, and on `index.html`'s module script (extracted), for both this branch and main.

## 3 · Proof: no look tag, and a baked file, draw as on main

**No tag (a natural world: the client's `LookExport.Build` returns null and writes nothing, `LookExport.cs:85`):**
- `thalyn-look.js:22-25`: `readLook` returns null without `tx.look`. Then at `index.html:575` `look` = null (unless the page URL carries `?look=`, a preview aid). The guarded block `:578` never runs: no palette fetch, no water re-grade, no pass set.
- `index.html:576-577` and `:769-770` call `lookRender.set(null…)` / `inkRender.set(null…)`. `thalyn-lookrender.js:198` returns before `insertPass` (`:199`), and `thalyn-ink.js:302,317` does the same before `:318`. So neither pass is ever inserted into the composer: the post chain is main's.
- `thalyn-zoneatmo.js:30` returns null without `extras.thalyn.zones`. The client writes zones only when 2 or more biomes wear different rows (`GltfAtmosphereExtras.cs` `CaptureZones`, `distinct.Count < 2` return), which always comes with a tag. With `zoneAtmo` null, `atmoState()` (`index.html:378-399`) computes exactly main's old `apply()` values, and the per-frame zone step (`:1606`) is skipped.
- `TINK.tagFieldMeshes/tagNodeTags` (`:837-838`) only *enable* extra layer bits on meshes. Layer 0 stays on, so the camera draws them as before.
- **Not identical to main:** URL-loaded worlds open on the diorama table (`:1007`; skipped by `?diorama=0`, `?session=`, a headset, a Christmas card, or a world with no straight cut edge). The "Share card · 4 looks" button shows (`:994`). Once you Dive in or Walk, the world is main's.

**Baked (`extras.thalyn.look.baked = true`; the client sets it in `GltfExportAdapter.cs:1599-1601` for Looking-Glass hand-tint and for any worn material recipe: Felt / Clay / Wax / Sugar & Snow):**
- `index.html:587-591`: the render layer is set to natural, and ink is set with `baked: true`, which `thalyn-ink.js:302` turns off. No live layer.
- The one step a baked file still runs is the water grade (`:581-584`, `thalyn-look.js:71-75`). It returns the input unchanged when the row has no `water` channel (`:73`). **No look the game can bake has a water row** in today's table (lookingglass, felt, clay, wax, sugar_snow). The bench asserts this, so it fails if the client ever adds one. Strictly, this guarantee rests on the table data plus that test, not on a code branch. To make it unconditional, add `!look.baked &&` to the `if` at `:581`. One line; I did not make it because the 11-03 design (`426a766`) says the water grade deliberately stays.
- Edge case: a baked scene look plus a different look on another biome writes `zones`, so per-biome fog/sun applies. That is app parity, not main parity.

## 4 · The demo looks against what the client writes today

Client tag today (`Styles/LookExport.cs:36-61`, written by `GltfExportAdapter.cs:1576-1604`): v2, `renderRow` = the live LookPalette id (only if the client table has it, `:1587`), plus `baked/bakedLook`, `label`, `recipeHash`, `lookId`, `body`, `remixOf`. Every v1 field is unchanged. The viewer reads `version`, `renderRow`, `byZone`, `baked`, `bakedLook`, so nothing it reads was renamed. `canon()` (`thalyn-look.js:19`) folds `sugar_snow` / `Sugar Snow` / `sugarsnow` to the same key.

The client's render-row fields (`Styles/LookRenderPlan.cs:21-127`) match what `thalyn-lookrender.js:136-149, 188-215` reads, except `outline.creases` (see gaps).

| Look | Tag read | Drawn layer | Water by the LOOK (gap 6) | Paths + snow colours (gap 5) | Frozen water |
|---|---|---|---|---|---|
| **Natural** | no tag → `thalyn-look.js:22-25`; a tag naming natural → identity `:44` | none (`thalyn-lookrender.js:198`) | tone pair, as main (`index.html:570`) | n/a | n/a |
| **Saturday Cartoon** (`saturdaycartoon`) | `index.html:575` → `rowFor` `thalyn-look.js:41-46` | grade + outline + toon bands at laptop/desktop, grade only on phones (`thalyn-lookrender.js:136-149`, set `:188-215`, inserted `:199`); bench ✓. **No crease lines** (`:8`) | ✓ deep/shallow graded by the row (`thalyn-look.js:71-75`, applied `index.html:581-584`); `rimM 0.45` (shore rim) NOT drawn | ✗ not drawn: the viewer never reads `row.path` / `row.snow`, and the baked ground has neither (client gap D) | n/a |
| **Toytown** (`pastelclay`) | same | grade (blur, brush) + soft 1px outline + wrap toon; bench ✓ | ✓ graded; `specPower/specIntensity/calm` NOT drawn | ✗ same | n/a |
| **Golden Storybook** (`goldenstorybook`) | same | grade (posterise, warm, vignette, grain) + 1px outline + toon bands; bench ✓ | ✓ graded | ✗ same | n/a |
| **Sugar & Snow** (`sugar_snow`) | same; baked → `index.html:587` | none: no `render` block, and baked (`:587-591`); grade, frost and coat are in the textures (client `LookExportBake.cs:279-401`) | none (no water row): water = main | snow colour comes in only through the client's recipe bake of the ground; path tint ✗ | ✗ **open water**. The file carries only the name; the row says `freezeWater: true`, and the client lists `Thalyn_IceSheets` as not exported (GEA:3535) |

Sun, ambient and fog are not re-graded by the viewer on purpose: the client exports them already graded (`thalyn-look.js:11-12`).

## 5 · Remaining gaps (written down, not built)

1. **Sugar & Snow ice.** Best fix is client-side (slice F: write the ice sheet as a mesh). A viewer-only version (row `freezeWater` → still, pale, no mirror) would invent the ice colour. **M.**
2. **Look path tint + snow colour.** These must be baked into the ground on the client (slice D, `_ThalynLookPathTint` / `_ThalynSnowLook`). The viewer has no path or snow mask over the baked ground. **S client.**
3. **Look water character** (`rimM`, `specPower`, `specIntensity`, `calm`; client `LookPalette.cs:51-53`) is not read by `thalyn-water.js`. Needs the in-app numbers first (`[LookWater]` log line). **S-M viewer.**
4. **Saturday Cartoon creases.** The viewer outline is depth-only, with no normals buffer (`thalyn-lookrender.js:8`), so `creases:true` draws no inner crease lines. **M.**
5. **Per-biome render rows.** The viewer draws the scene row only (v1 law, `LookExport.cs:41`). Per-biome sky/fog do switch (zones).
6. **The diorama + share card** go live with this merge for every link-loaded world. Your call. Interplay with the newer AR "View on your table" and the XR entry while the table is up was **not traced**: XR is guarded at `:1124`, AR is not.
7. **Palette copy drift.** Re-run `THALYN_CLIENT_PALETTES=<client json> node viewer/looks/thalyn-look-parity.test.mjs` after any client table change. `looks/LookPalettes.json` is fetched without a `?v=` stamp, so browsers may keep the old copy for the Pages cache time.
8. **`looks/viewer-take-look`** (2 commits, the "Take this look" chip) exists only on your PC. It needs the same merge onto this branch (expect the same 4 `index.html` hunks).
9. **This handover file sits at the repo root.** GitHub Pages would publish it if merged to main, so delete it (or move it) in the merge.

## 6 · Summary

1. Branch `looks/viewer-parity-nov11` = `origin/main` @ `46a6b4c` + `origin/looks/viewer-look-tag` (17 commits), merged, not rebased.
2. 4 conflicts, all in `viewer/index.html`, all resolved keeping both sides. The diorama is suppressed under an active Christmas card.
3. `LookPalettes.json` re-copied byte-identical from client `489632a0` (10 rows).
4. Saturday Cartoon, Toytown, Golden Storybook: tag read, render layer drawn, water graded by the look.
5. Sugar & Snow: read as baked, nothing drawn live; water stays open (ice not built).
6. Path/snow look colours are not drawn anywhere; that is a client bake job.
7. No-tag and baked files: land, light and water are main's, with lines cited in §3. The diorama opening and the Share-card button are the visible differences.
8. Checks: `node --check` on all viewer JS + index module; 2 benches ALL PASS (10 + 26). No pixels seen.
9. Nothing pushed to main, no force push, no Pages settings touched.
10. Code tip `0c7894c`; the handover commit sits on top (sha in the push report).
