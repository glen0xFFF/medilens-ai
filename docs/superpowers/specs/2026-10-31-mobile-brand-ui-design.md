# MediLens AI mobile app: brand-led UI, light and dark mode

Date: 2026-10-31. Owner: Glenox. Status: draft for owner review.

## Why

The app works, but it looks like a prototype: plain text title, pale blue Material buttons, five
home buttons of equal weight, and a result screen that is one long paragraph. The hackathon demo
video (deadline Nov 4 2026 9 PM ET, feature freeze Nov 3) is the first audience; low-vision people
who rely on the app reading aloud are the second. The owner has a finished logo sheet
(`G:/_gnox/_METAPROJECT/Logo.jfif`: horizontal logo, stacked logo, app icon, monochrome mark,
dark-background logo; navy plus a teal-to-cyan gradient). None of it is used in the app yet.

## Decisions made by the owner

- **Direction A, "brand-led"** (chosen from two mockups): navy and teal gradient from the logo, the
  logo in the header, one big gradient "Scan medicine" card, secondary actions as tiles, and a
  result screen built from cards with a sticky audio player.
- **Light and dark mode both**, each in the brand palette.
- Demo first, low-vision users second. The owner said "adjust the design based on that" to the
  light/dark mockup; the mode-selection behaviour below is my call on that basis.

Mockups: `.superpowers/brainstorm/5019-1793419930/content/direction.html` (A vs B) and
`light-dark.html` (A in light and dark, plus Settings).

## Goals

1. Every screen uses the brand palette in light and dark mode, and the logo where a header shows
   brand (Home: horizontal logo; inner screens: the M mark beside the title).
2. Home: a hero gradient card "Scan medicine" with the subtitle "Point at the label. I'll read it
   aloud."; "Read existing photo" and "Try a demo" as two side-by-side tiles; "Safety and
   limitations" and "Settings" as list rows with a chevron; the line "Always confirm with a
   pharmacist or doctor." stays visible on Home.
3. Result (owner chose "keep the reading as the main text"): order is demo marker (if demo) →
   status badge → "Differences from the registry" list (if any) → **Key facts** tiles → the
   spoken summary `explanation.displayText`, word for word, in a card titled "What the label
   says" → Safety notes → actions (Label fields, Verification and sources, Ask a question, Retake
   photos when shown today, Safety and limitations, Back to home, which still deletes the server
   copy). Nothing shown on Result today is removed.
   - Key facts tiles: Medicine (brand name, generic and form below), Strength, Expiry, built from
     `result.label.fields`. A field whose legibility is `clear` shows its value large. A field
     that is `partial`, `unreadable`, missing or in conflict with the registry shows "Unclear:
     check the pack" instead of a value (a conflict additionally points to the differences list).
     No value is ever shown as certain unless it is `clear` (docs/SAFETY.md). When `label` is
     null (not a label, loose pill, unreadable photo) the Key facts row is not shown.
   - Speech controls on Result: the same four separately named buttons as today (Play/Resume,
     Pause, Repeat, Stop), with the same TalkBack labels, restyled into a sticky bottom bar with
     "Reading part N of M" and a progress bar; Play uses the gradient. Content is padded so
     nothing hides behind the bar. On Welcome and Ask the same controls are restyled in place.
4. Settings gains **Appearance: System / Light / Dark** (segmented control), default **System**.
   High contrast stays as its own toggle and wins over Appearance when on (it is always the
   black/yellow palette, as today). Text size becomes a 3-way segmented control (Normal / Large /
   Extra large). Speech rate shows a word ("Slower", "Normal", "Faster") instead of the bare
   number.
5. App icon, adaptive icon and splash use the logo (the "App Icon" and the mark from the sheet,
   cropped). Splash background navy `#091E33` in dark, `#F3F8FC` in light.
6. The other screens (Demo list, Analyzing, Preview, Camera, Label fields, Verification and
   sources, Ask, Safety, error states) get the same palette, card and button styles, without layout
   changes beyond what the styles imply. The Analyzing screen shows the M mark and the stages as
   the server reports them (the list grows as events arrive, in the server's wording; nothing is
   pre-filled, and a skipped step is never shown as done), with the newest stage highlighted in
   the gradient, because it appears on camera.
7. High contrast keeps today's black/yellow palette: solid yellow replaces every gradient, and
   headers use the monochrome logo mark (white on black). The 7:1 tests cover it.

## Palettes (starting values; contrast must pass, see constraints)

| Token | Light | Dark |
| --- | --- | --- |
| background | `#F3F8FC` | `#091E33` |
| surface (cards, tiles) | `#FFFFFF` + 1 px `#D6E4EF` border | `#11304D` + 1 px `#1E4C72` border |
| text | `#0B2440` | `#E8F1F8` |
| textMuted | `#3D6385` | `#9CC0DD` |
| brand gradient (hero, primary buttons, play) | `#1593C7` → `#20C3B5`, 135° | same |
| onGradient text | `#FFFFFF` if it passes 4.5:1, else `#04121F` | `#04121F` |
| accent (icons, toggled values) | `#0E7F99` | `#3CD3C4` |
| status, demo banner, danger | keep today's hues, tuned to the new backgrounds | same |

Status badges keep icon + text + colour (never colour alone), as today.

## Constraints

- Accessibility must not regress: the existing `theme.test.ts` contrast checks (AA 4.5:1 for
  light and dark text pairs, AAA 7:1 for high contrast) stay and cover the new palettes, including
  text on the gradient at both gradient ends. TalkBack labels, roles and announcements stay as
  they are; every new tap target is at least 48 dp; layouts work at text size 1.5×.
- No new screens, routes, API calls or contract changes. Spoken text is unchanged.
- Only libraries already in the project, or Expo SDK 58 packages installable with `npx expo
  install` (for the gradient, `expo-linear-gradient`). No custom fonts.
- Logo crops come from `Logo.jfif` (1408×768 JPEG). The sheet has a white background, so the
  marks need a transparent background (cut out, or re-drawn as a clean PNG) to sit on navy and on
  light backgrounds. Icon sizes per Expo's Android adaptive-icon rules (foreground safe zone).
- Existing tests (`npm test`, 319 mobile jest tests) stay green; snapshot or text assertions that
  depend on old copy are updated only where the copy deliberately changed (Home subtitle, tile
  labels "Try a demo", speech-rate words).
- Feature freeze Nov 3: this lands, is built as an APK and checked on the owner's Infinix
  (Android 15, 720×1600) before then.

## Non-goals

- No change to the analysis flow, server, speech logic or wording of results (the Key facts
  tiles add a view of existing fields; the spoken and displayed summary text is unchanged).

## Calls made by Claude (owner to check)

- Appearance defaults to System, with a Light / Dark override in Settings.
- Everything on Result today stays; the differences list moves to just under the badge.
- Analyzing lists only stages the server reported.
- Speech controls keep four separately named buttons for TalkBack.
- High contrast: solid yellow for gradients, monochrome logo mark.
- No iOS-specific polish (Android is the demo device).
- No animation work beyond what the gradient and pressed states need.

## Anti-goals (failure even if it "works")

- Anything that makes the app harder to use with TalkBack or at large text.
- Brand colours that drop any text pair under its contrast floor.
- The demo-data warning becoming less visible: the DEMO DATA marker must remain on every demo
  screen.

## Left to the builder

- Component structure (new `GradientButton`, `Tile`, `ListRow`, `InfoCard`, `BottomPlayer`, or
  extending `BigButton`), and how `useTheme` reads the new Appearance setting.
- Exact spacing, radii and shadow values (mockups use 14–20 px radii).
- How the logo PNGs are cut out, as long as edges are clean at 3× density.
- Settings storage migration for the new field (settings key is `medilens.settings.v1`; an
  unknown or missing field falls back to System).
