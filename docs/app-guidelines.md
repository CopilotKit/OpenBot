# App guidelines

What we have agreed about OpenBot's apps: the phone app (`mobile/`), and the web app and OpenBot
Desktop (`app/`, `desktop/`). Read the part for the app you work on before you plan a screen or a
feature for it.

These are product guidelines: what each app is for, what it is built with, and what it leaves out.
[Don't break the API or the database](api-and-migrations.md) holds the hard rules, and they come
first.

## Every app

### One color scheme, used sparingly

Every app draws with the same colors, and with few of them. This is strict: a change that breaks
one of the rules below is not merged.

The scheme is the set of tokens in [`tokens/src/scheme.ts`](../tokens/src/scheme.ts), each with a
light and a dark value and what it means: `background`, `foreground`, `card`, `popover`, `primary`,
`secondary`, `muted`, `accent`, `destructive`, `success`, `warning`, `border`, `input` and `ring`,
and the chart and sidebar sets.

The grays are Tailwind's slate. In light each gray is slate at its own lightness; in dark, slate's
hue moves from 265 to 252 with 40% of its tint, since slate's own dark leans indigo and reads purple.
CopilotKit's lavender marks only what it means: the `ring`, the selected sidebar row
(`sidebar-accent`) and the empty pattern. `tokens/tests/slate.test.ts` holds both.

- **Only the tokens.** No color value in a screen or a component: no hex, no `rgb()`, no `oklch()`.
  No class from Tailwind's palette either (`bg-blue-500`, `text-amber-600`). Write `bg-background`,
  `text-muted-foreground`, `border-border`. A tint is the token with an opacity: `bg-warning/10`.
- **Mostly neutral.** A screen is background, cards, text, muted text and borders. Nothing is
  colored to decorate it or to make it stand out.
- **A color means one thing.** `destructive` is for what deletes or what failed. `success` is for
  what worked, or is working. `warning` is for what needs the person: something waits on them, or
  may not go as they expect. `ring` is for focus. If none of those is what you mean, the answer is
  no color.
- **The token has the dark value.** Write the class once. No `dark:` override of a color.
- **Light and dark, both.** A token carries both values, so a screen drawn with tokens has both.
  Check both before you ask for a review.
- **A new color is a change to the scheme.** If a screen needs a color the scheme doesn't have,
  agree it first. Then it becomes a token in `tokens/src/scheme.ts`, with a light and a dark value
  and what it means, for every app. It is never added in one app only.
- **A color is never renamed or removed.** A customer's theme sets the scheme's colors by name, so a
  name the scheme drops leaves their theme doing nothing. Change its value instead.

### Where the scheme lives

[`tokens/`](../tokens) (`@openbot/tokens`) is the one source. Every app that can't import it keeps a
copy, and the copies are written, never edited:

| Copy | Written as |
| --- | --- |
| `app/src/theme.css` (the web app, and the Recorder's pages, which import it) | CSS custom properties, light in `:root` and dark in `.dark` |
| `desktop/src/styles.css`, `desktop/src-tauri/src/connected/sign_in.rs` (OpenBot Desktop's setup window and sign-in page) | CSS custom properties, the tokens each uses |
| `desktop/src-tauri/src/first_paint.rs` (the window's color before the page draws) | RGB |
| `mobile/src/scheme.ts` (the phone app) | Hex, since React Native draws no `oklch()` |

To change a color: change it in `tokens/src/scheme.ts`, run `bun run tokens:generate`, and commit
the scheme with every copy it rewrites. A copy inside a hand-written file sits between two marker
comments (`tokens/src/scheme.ts, light: …` and `end of tokens/src/scheme.ts`); the generator writes
only between them. A new copy is added to `tokens/src/targets.ts`.

The tests that hold it, and what makes each fail. Fix the change, never the test:

| Test | Fails when |
| --- | --- |
| [`tokens/tests/generated.test.ts`](../tokens/tests/generated.test.ts) | A copy isn't what the scheme writes: edited by hand, or the scheme changed without running the generator. |
| [`app/tests/color-scheme.test.ts`](../app/tests/color-scheme.test.ts) | The web app has an amber or green class anywhere, or another palette class in a file that didn't already have one. |
| [`app/tests/design-tokens.test.ts`](../app/tests/design-tokens.test.ts) | The surfaces stop going darkest to lightest, a menu's highlight matches its surface, or `theme.css` declares a token beyond the scheme's. |

Two places don't keep these rules yet. Don't add to either:

- A few web app files still draw with Tailwind's palette: decorative tones in onboarding, a
  sidebar badge, a call button. The test lists them, and the list only gets shorter. Move a file's
  colors to tokens and take it off the list.
- The phone app's `src/colors.ts` takes its colors from the scheme but one: a blue for a tappable
  word. The file goes as the screens move to the stack below.

## The phone app

### It is not a clone of the desktop app

The phone app doesn't have to do everything the web app and OpenBot Desktop do. A screen on the
desktop is not a reason to build the same screen on the phone.

### For launch: the core Bot experience

For launch, the phone app focuses on three things:

- Bot screens
- Conversations
- Routines

Before you start work on the phone app, check that it is part of one of the three. If it isn't, it
is not launch work: raise it before you build it.

### A Bot's computer is a tool call

For now the phone app has no Computer screen. When a Bot uses its computer, the conversation shows
it as a tool call. The Computer screen `mobile/` has today is not part of launch.

### The stack

The phone app's stack is what `mobile/` has today, plus the styling and components of
[Better-T-Stack's native Uniwind template](https://www.better-t-stack.dev/new?fe-w=none&fe-n=native-uniwind&rt=none&be=none&api=none&db=none&orm=none&au=none&add=none).
That template has no backend, no API layer, no database and no sign-in of its own, because ours
stay.

What `mobile/` has today, which stays:

| Part | What we use |
| --- | --- |
| App | Expo with React Native and React 19, in TypeScript's strict mode. One app for iOS and Android. |
| Screens | Expo Router: a file under `mobile/app/` is a screen. |
| The API | A client generated from `api/openapi.yaml` by Orval, in `src/api/generated`. Never edited by hand: see [mobile/AGENTS.md](../mobile/AGENTS.md). |
| Sign-in | Better Auth's Expo client. The session is kept in `expo-secure-store`. |
| Notifications | `expo-notifications`. |
| Builds | EAS. In development it runs as a development client (`expo-dev-client`), not in Expo Go. |
| Packages | npm, with `mobile/package-lock.json`. The rest of the repository uses Bun. |

What the template adds:

| Part | What we use |
| --- | --- |
| Styling | [Uniwind](https://uniwind.dev): Tailwind CSS 4 classes on React Native components, written in `className`, as in the web app. |
| The theme | `mobile/global.css`: the one stylesheet. It imports Tailwind, Uniwind and HeroUI Native's styles, and the color scheme, written into it from `tokens/`. |
| Components | [HeroUI Native](https://github.com/heroui-inc/heroui-native): buttons, fields, sheets, dialogs and the rest, built on Uniwind. |
| Under them | `react-native-reanimated`, `react-native-gesture-handler`, `react-native-keyboard-controller` and `react-native-svg`, which HeroUI Native's components need. |

How we use it:

- **Expo's SDK first, on its own.** `mobile/` is on Expo SDK 55 and the template on 58. Move
  `mobile/` to the template's SDK in a change of its own, before any Uniwind work, so a problem
  from the upgrade is never mistaken for one from the restyle. Keep to the newest SDK from then on.
- **Add the template's parts to `mobile/`.** Don't generate a new app from it. Its drawer, tabs and
  sample screens are not ours.
- **Install with `npx expo install`,** so each package gets the version that fits our Expo SDK.
- **Read the docs for the SDK we're on.** Expo renames and moves APIs between SDKs. Check the
  version in `mobile/package.json` and read that version's docs before you use an Expo or React
  Native API from memory.
- **Style with `className`.** No `StyleSheet.create`, and no style object for something a class can
  say.
- **`src/ui.tsx` and `src/colors.ts` are the old way.** They are the hand-written styles the
  screens use today. A screen moved to Uniwind stops using them, and they are deleted when the last
  screen has moved.

### What draws what

The platform draws everything around a screen. HeroUI Native draws what is inside it.

| What | Drawn by |
| --- | --- |
| Stacks, headers, titles, back buttons | Expo Router's native `Stack`, set in the route's layout or the screen's options. |
| Tabs | Expo Router's native tabs. |
| Header and toolbar buttons, header menus, search in the header | The native `Stack` toolbar and search bar. |
| Sheets and modals | Expo Router's native presentations (`formSheet`, `modal`). |
| Pickers, switches, sliders, system menus | `@expo/ui`, so they look and behave as the platform's own. |
| Buttons, fields, cards, chips, alerts, and the rest of a screen's content | HeroUI Native. |
| Long lists: conversations, messages, runs | A virtualized list (`FlatList`, or one built for chat). Never a `ScrollView` with a `map` inside. |

- **Native chrome stays native.** Don't draw a header, a tab bar or a sheet yourself, even when
  HeroUI Native could make one that looks the same. The native one gets each platform's look for
  free, including iOS's glass material and Android's Material behavior, and keeps it as the
  platforms change.
- **Don't imitate glass.** No blur, gradient or translucent card to look like the system's
  material. It comes from the native components or not at all.
- **The lightest screen that works.** Use HeroUI Native's components, but only as many as the
  screen needs. A screen can be text and one button. Add a card, a chip or an alert only when it
  groups something, shows a state, or can be acted on.
- **Use a component before you build one.** First one `mobile/` already has, then HeroUI
  Native's. Build your own only when neither fits, and build it from the same tokens.
- **Check what you can't typecheck.** Before you ask for a review of a screen, look at it on iOS
  and on Android, in light and in dark, and with the keyboard open if it has a field. Say in the
  pull request which of those you looked at.

### The color scheme on the phone

The rules under [One color scheme, used sparingly](#one-color-scheme-used-sparingly) hold here too.

HeroUI Native has its own names for the tokens, and two of them mean something else than the web
app's token of the same name. When Uniwind goes in, `mobile/global.css` takes the scheme under
HeroUI Native's names, for light and for dark, written by `bun run tokens:generate`: add it to
`tokens/src/targets.ts` with this mapping, rather than writing the values by hand. Until then the
screens read `src/scheme.ts`. No other file in `mobile/` has a color value in it, but
`src/colors.ts`'s one blue.

| HeroUI Native token | Takes the scheme's |
| --- | --- |
| `background`, `foreground` | `background`, `foreground` |
| `surface` | `card` |
| `overlay` | `popover` |
| `default` | `secondary` |
| `muted` (a text color here) | `muted-foreground` |
| `accent` (the main action here) | `primary` |
| `danger` | `destructive` |
| `success` | `success` |
| `warning` | `warning` |
| `border` | `border` |
| `focus` | `ring` |

## The web app and OpenBot Desktop

Beyond the color scheme above, no product guidelines yet. How a screen is laid out, worded, and
reads and writes its data is already written down, in the skills under `.claude/skills/`:

- `openbot-screen-layout`: the default layout of a screen.
- `openbot-copy`: the words and the voice of anything a person reads.
- `openbot-data-access`: how the browser app reads and writes server data.

### The look

The web app keeps one look, drawn by the primitives in `app/src/components/ui` and the scheme's
tokens. A screen draws with them and adds no look of its own. Sizes stay: this look changes how
things are drawn, not how big they are.

1. **Colors.** Only the scheme's tokens, as above.
2. **Type.** Inter and the type scale in `theme.css`. Controls, rows and navigation are `text-sm`;
   labels, times and counts are `text-xs`. No text size written by hand (`text-[13px]`).
3. **Corners.** All from `--radius`. Controls are `rounded-md`, cards and the page's panel
   `rounded-lg`, menus, dialogs and the message box `rounded-xl`, round things `rounded-full`.
   `rounded-none` squares a part off. No other step and no corner of its own (`rounded-[20px]`).
4. **Surfaces.** The frame (`sidebar`), the panel the page sits in (`background`), cards on it
   (`card`). A card has a hairline border in light and in dark. Every line (`border`, a field's
   `input`, the sidebar's `sidebar-border`) is the text color at 20% in light and 16% in dark,
   about 1.6:1 against a card in both, so no line in the app is fainter than another.
5. **Shadows.** A shadow says how far something floats, as Linear draws it, and Tailwind's own
   steps only:
   - none for everything in the page: the panel, cards, rows, fields, the sidebar;
   - `shadow-xs` for a control pressed on a surface: an outlined button, a switch's knob, the
     chosen tab, a checkbox;
   - `shadow-lg` and a border for what opens beside the thing that opened it: menus, selects,
     popovers, tooltips, toasts;
   - `shadow-2xl` and a border for what sits over the app: dialogs, the command menu, sheets.

   Nothing else has a shadow, and none is written by hand.
6. **Sizes.** Heights, padding and spacing come from the primitives and `PageShell`. A screen
   writes no size by hand (`h-[43px]`); it uses the nearest Tailwind step, never a smaller one.
7. **Rows.** One card of rows with hairline dividers (`PageRows`). The leading icon is a 16px
   glyph in `muted-foreground` on a 32px tile with a hairline ring.
8. **The message box** is a flat card at rest. While someone types in it, it glows in `ring`. It
   is the only control that glows.
9. **Icons.** Tabler, at their usual sizes. The default line is 1.75, set once in `theme.css`. An
   icon that needs another line says why in a comment.
10. **Widths** come from `PageShell`. A screen sets no `max-w-*` of its own without a comment.
11. **Cards.** A card is `PageRows`, `PageCard` or `Card` (`components/ui/card.tsx`). No screen
    draws a bordered `bg-card` box by hand.
12. **One class, both themes.** No `dark:` override of a color: the token carries both values.
13. **Home's orb.** Behind Home's message box, OpenBot's orb is spread out as a pale field with
    rings of dots (`components/home/home-field.tsx`), and typing lights it. It is the app's one
    decoration: no other screen draws one. On the first Home of a visit the field draws itself in
    while the heading, the box and Explore Bots rise in; coming back to Home shows it in place.
    Nothing moves when less motion is asked for, and a skin has no field.

[`app/tests/ui-look-guard.test.ts`](../app/tests/ui-look-guard.test.ts) fails when a screen breaks
rules 2, 3, 5, 11 or 12. Screens drawn before these rules are counted in its allowlist, which only
gets shorter. After cleaning a screen up, rewrite the counts with
`OPENBOT_UPDATE_UI_LOOK_ALLOWLIST=1 bun test app/tests/ui-look-guard.test.ts`.
