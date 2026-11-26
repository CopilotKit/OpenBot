# The design system

How the web app's design system is built, and the rules for changing it. Read this before you:

- change a color, a radius, a font or any other token (`tokens/`, `app/src/theme.css`,
  `app/src/styles.css`);
- change, add or replace a primitive in `app/src/components/ui`;
- add a font, an icon set or a picture the interface is drawn with;
- build a screen from a design made in Figma or anywhere else outside the code.

It is for people and for coding agents alike. It is strict: a change that breaks one of the rules
below is not merged, however good it looks.

To draw a screen with the system, without changing it, read
[app-guidelines.md](app-guidelines.md) for the color scheme and
[the look](app-guidelines.md#the-look), and the `openbot-screen-layout` skill for the layout. This
page doesn't repeat them: they say what the system looks like today, and this page says what must
stay true when it changes.

## What it is built on

Three things hold the rest up. Every rule further down follows from one of them.

### 1. It is shadcn, and stays compatible with shadcn

The tokens are [shadcn](https://ui.shadcn.com)'s theme variables and the primitives began as
shadcn's components, on [Base UI](https://base-ui.com). The primitives are ours to change. Being
compatible means two things stay true, and a change is checked against both:

1. **A stock shadcn component fits in.** Copy a component from shadcn's registry into
   `components/ui`, in its Base UI flavor, and it takes our colors, corners and type from the
   tokens as it is. The one edit it may need is to its corner and shadow steps, to the ones
   [the look](app-guidelines.md#the-look) names. If it needs more than that, the system has
   drifted.
2. **A stock shadcn theme restyles everything.** Set only shadcn's standard variables
   (`--background`, `--primary`, `--radius` and the rest) and the whole app follows: every
   primitive, every screen, light and dark.

A customer's theme and every skin rely on the second. A change that makes either one false is a
change of design system, not a change to this one.

### 2. Surfaces come in levels

A screen is a few surfaces, one on another. Each level has its token, and the tokens are ordered:

| Level | Token | What it is | Edge and shadow |
| --- | --- | --- | --- |
| Frame | `sidebar` | The sidebar and the window's edge. The darkest. | None |
| Panel | `background` | What the page sits in. | None |
| Card | `card` | A group on the panel: rows, a form, a table. The lightest. | A hairline border, no shadow |
| Beside | `popover` | What opens beside what opened it: menus, selects, popovers. | A border and `shadow-lg` |
| Over | `popover` | What sits over the app: dialogs, sheets, the command menu. | A border and `shadow-2xl` |

On a surface, a fill marks a part of it: `secondary` and `muted` for a button, a badge or a tile,
`accent` for the highlighted row of a menu. Each surface and fill has a `-foreground` for the text
on it. Every line is `border`, the text color at one strength, so no line is fainter than another.

- **Choose the level by what the thing is,** never by the shade you want. A group of rows is a
  card. If a card looks wrong where you put it, the layout is wrong, not the token.
- **In the page, the level is the color. Above it, the level is the shadow.** Nothing in the page
  has a shadow, and a shadow never decorates: it says how far something floats.
- **Neighbors never match.** The frame is darker than the panel and the panel darker than a card,
  in light and in dark. In dark, a fill on a card is lighter than the card, so a button never reads
  as a hole. A menu's highlight differs from the menu and from the panel.
- **No level in between.** A surface that needs a shade or a shadow the levels don't have is a
  change to the system (below), not a `bg-card/80`, a `color-mix()` or a `shadow-md` in a screen.

[`app/tests/design-tokens.test.ts`](../app/tests/design-tokens.test.ts) holds the order of the
colors, and [`app/tests/ui-look-guard.test.ts`](../app/tests/ui-look-guard.test.ts) the shadows.

### 3. Light and dark, always both

Every token has a light and a dark value, so anything drawn with tokens has both modes.

- **A design with no dark version is not ready to build.** Don't ship the light half and keep "the
  old dark" under it: the two halves stop matching on the first screen.
- **A value set for light is set for dark,** in the scheme and in every skin
  ([`app/tests/skins.test.ts`](../app/tests/skins.test.ts)).
- **Write the class once.** A screen has no `dark:` override of a color. If the token's dark value
  is wrong, fix the token.
- **Look at both** before you ask for a review, every state included: hover, focus, pressed,
  disabled, invalid, empty and loading. Text on a fill is the place dark mode breaks first.

## Tokens

The colors and the rules for using them are in
[app-guidelines.md](app-guidelines.md#one-color-scheme-used-sparingly): only the scheme's tokens,
changed in `tokens/src/scheme.ts` and written out with `bun run tokens:generate`. On top of that:

- **The token set is shadcn's.** The color pairs, the chart and sidebar sets and `--radius`, plus
  our `success` and `warning`. A new token needs agreeing first, a light and a dark value, and one
  meaning.
- **No token for a component or for a state.** Not `--color-primary-hover`, not
  `--spacing-menu-item-x`, not `--radius-card`. A stock shadcn theme doesn't set them, so they stay
  at our values while everything else changes, and the theme is broken. A state is made from the
  tokens there are, as shadcn does it: hover is `hover:bg-primary/80` or `hover:bg-muted`, disabled
  is `disabled:opacity-50`, focus is `ring-ring/50`, invalid is `destructive`.
- **A token is a token wherever it is declared.** `:root`, `.dark`, `@theme` or a component's own
  stylesheet: the rules above hold for all of them. The test reads only `:root` and `.dark`; the
  rule is wider than the test.
- **The shared scales keep their meaning.** `rounded-lg`, `text-sm`, `p-4` and `shadow-lg` mean
  what they mean in Tailwind and shadcn. Corners all come from the one `--radius`: to make the app
  rounder or sharper, change that one value, as the look did. Don't set `--radius-lg` and its
  neighbors to pixel values of your own. The type scale and the spacing grid in `theme.css` are
  not redefined to match a design.
- **Names are a contract.** A customer's theme sets tokens by name. A token is never renamed or
  removed; change its value.

## Primitives

`app/src/components/ui` holds the primitives. Screens are built from them.

- **Use one before you add one, add one before you build one.** First a primitive we have. Then
  shadcn's, copied from its registry and brought to the look's corner and shadow steps. Build your
  own only when neither fits, from the same tokens, with shadcn's conventions: `cva` variants, a
  `data-slot` on each part, `cn` for the classes. Check shadcn first: badge, radio group, kbd and
  the like are already there.
- **A variant or a size keeps its meaning.** `default`, `secondary`, `outline`, `ghost`,
  `destructive` and `link`, and `xs`, `sm`, `default` and `lg`, look and measure as they do today
  and as a shadcn user expects. Moving `sm` by 4px, or making every button a pill, redraws every
  screen at once. A new look is a new variant, agreed first.
- **One system.** No second kit beside the first, no "legacy" mode, no variant that switches
  between two looks. A skin sets the scheme's tokens under `:root[data-skin]` and nothing more. If
  a change needs a switch to keep old screens as they were, it is the wrong change.
- **Every state, both modes.** A primitive is done when rest, hover, focus, pressed, disabled and
  invalid are all drawn, in light and in dark, and the keyboard reaches it.

## The rest of the look

[The look](app-guidelines.md#the-look) names the type, the corners, the shadows, the sizes and the
icons a screen draws with. What it leaves to this page:

- **No pixel value copied from a design** (`w-[91px]`, `h-[43px]`). Use the nearest step of the
  scale, never a smaller one. Sizes stay: a new look changes how things are drawn, not how big they
  are.
- **One typeface and one icon set, in every app.** Inter and Tabler today, in the web app, OpenBot
  Desktop and the extension. Changing either is a change for all three at once, agreed first. It
  never lands in one app.
- **Draw with tokens, not with pictures.** A picture has one set of colors: it can't follow dark
  mode, a skin or a customer's theme. Draw interface parts in CSS or as an SVG that takes
  `currentColor`. A picture that is content, such as a screenshot or a photo, is a dependency like
  any other: agree it first, and say what it weighs.
- **Animate in code, not in video.** An animation is CSS, SVG or a canvas, drawn with the tokens,
  so it follows light and dark, a skin and a customer's theme laid over ours. A video, a GIF or an
  animation exported from a design tool has its colors baked in: it shows one look whatever the
  theme says, and it weighs megabytes where code weighs kilobytes. This holds everywhere,
  onboarding and empty states included. If a design hands you a video of an animation, build the
  animation.
- **Check contrast before you choose a color,** in light and in dark: 4.5:1 for text, 3:1 for the
  edge of a control that has no other cue, such as a checkbox, and for the focus ring. A color that
  fails as text is not rescued with a second token for "the same color, as text".
- **Motion stops when less motion is asked for.** An animation in code can stand still. Don't
  swap in a picture of one frame.

## Building from a design

A design in Figma is a proposal. The tokens and primitives in the code are the system.

1. **Map it first.** For each part of the design, name the primitive, the variant and the tokens
   that draw it.
2. **List what doesn't map:** a color the scheme lacks, a corner off the scale, a component we
   don't have, a state the design didn't draw, a missing dark version.
3. **Raise that list before you build.** Each item ends one of three ways: the design moves to
   what the system has, the system changes for every screen in a pull request of its own, or the
   item is dropped.

Don't close the gap yourself by adding a token, a one-off class or a copy of a primitive. Don't
bring a design's variables in as tokens. "Match the design exactly" is never a reason to break a
rule here.

If you are a coding agent and a task asks for something this page rules out, stop and say which
rule it breaks. Don't do it quietly, and don't work around it.

## Changing the system

A change to a token or a primitive changes every screen, so it lands differently from a screen.

- **Agree it first.** Say what changes and why, before the pull request.
- **In a pull request of its own.** No screen work in it, and one concern: the scheme, or one
  primitive, or the icons. A change too big to review is not merged.
- **Show it.** Each primitive it touches, in light and in dark, and under each skin. Say in the
  pull request what you looked at.
- **Fix the change, never the test.** The tests below are the rules. If one fails, the change is
  wrong. A test changes only when the rule it holds was changed, and that was agreed first.
- **The lists only get shorter.** Some tests keep a list of files that broke a rule before it was
  written. Take a file off when you clean it up. Never add one.
- **A new dependency is a decision of its own:** a font, an icon set, a component library.

| Test | Holds |
| --- | --- |
| [`tokens/tests/generated.test.ts`](../tokens/tests/generated.test.ts) | Every app's copy of the scheme is what the scheme writes. |
| [`app/tests/design-tokens.test.ts`](../app/tests/design-tokens.test.ts) | The surface levels keep their order, and `theme.css` declares only shadcn's tokens and ours. |
| [`app/tests/color-scheme.test.ts`](../app/tests/color-scheme.test.ts) | No class from Tailwind's palette in a screen. |
| [`app/tests/ui-look-guard.test.ts`](../app/tests/ui-look-guard.test.ts) | No corner, shadow, text size, `dark:` color or hand-drawn card of a screen's own. |
| [`app/tests/ui-primitives-look.test.ts`](../app/tests/ui-primitives-look.test.ts) | Every primitive keeps the look's corner and shadow steps, a copied shadcn one included. |
| [`app/tests/ui-look-theme.test.ts`](../app/tests/ui-look-theme.test.ts) | The one radius, the icons' line, and every line at one strength. |
| [`tokens/tests/slate.test.ts`](../tokens/tests/slate.test.ts) | The grays are one family, in light and in dark. |
| [`app/tests/skins.test.ts`](../app/tests/skins.test.ts) | A skin sets every light token for dark too. |
| [`app/tests/checkbox-contrast.test.tsx`](../app/tests/checkbox-contrast.test.tsx) | A checkbox's edge can be seen. |

## Before you ask for a review

- [ ] Would a stock shadcn theme still restyle everything you touched?
- [ ] Would a stock shadcn component still look right beside it?
- [ ] Is every surface the level it should be?
- [ ] Did you look at it in light and in dark, every state, and under a skin?
- [ ] No new token, no color value, no pixel value, no `dark:` color in a screen?
- [ ] No picture or video standing in for something code can draw or animate?
- [ ] No variant or size changed its meaning?
- [ ] No test edited to pass, and no list of exceptions made longer?
- [ ] Is a change to the system in its own pull request, agreed beforehand?
