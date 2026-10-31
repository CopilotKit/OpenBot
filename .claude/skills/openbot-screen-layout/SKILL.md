---
name: openbot-screen-layout
description: The default layout for every OpenBot configuration screen — PageShell and its prose/wide widths, PageSection and PageRows, Item row composition, the settings-row pattern where a summary and a chevron open a dialog, and the size and variant vocabulary. This is what a new screen looks like unless an instruction says otherwise. Use when adding or changing a screen under app/src/routes, adding a row to an admin or settings page, choosing a Button or Item size, picking between a bordered and a filled row, laying out a dialog, or reviewing a diff that adds max-w-*, a hand-drawn card, or a new spacing scale under app/src. Don't use for where the data comes from (that is openbot-data-access), for the gallery components under components/gallery that a Bot draws, for the chat and channel surfaces, or for editing the primitives under components/ui themselves.
---

# OpenBot Screen Layout

## When To Use

This skill applies to any change under `app/src/routes` that puts a configuration screen on the
screen — a new admin page, a new settings section, a new row on an existing page, a detail page
behind a list. Twelve screens render through `PageShell` today and seven build their rows out of
`Item`; all of them look the same on purpose.

It does not cover where the data comes from — that is `openbot-data-access`, which owns queries,
mutations, and the pending/error/empty/rows branching. It does not cover the gallery components
under `components/gallery`, which a Bot draws inside a conversation rather than a person navigating
to. It does not cover the primitives under `components/ui`, which are this repository's own design-system
primitives: they began as shadcn output, but there is no upstream to re-pull from, and they are
formatted and linted like the rest of the app.

## The Default

**A new screen uses this layout. Deviating from it needs a reason given in the request.**

This is the point of the skill. The decisions here — the width, the spacing, the heading sizes, the
row anatomy, which control means what — are already made, and they are already made the same way on
every other screen. Somebody who does not work in the frontend should be able to add a page that
looks like it belongs without making a single visual decision, by reaching for `PageShell`,
`PageSection`, `PageRows` and `Item` and filling them in.

The failure this prevents is the one the `PageShell` doc comment describes: Admin was once nine pages
that shared no layout — four container widths, four heading sizes, four padding schemes, three of
them drawing their own buttons and inputs. It did not read as a different screen, it read as a
different application, at exactly the moment an administrator was deciding whether to trust it with
credentials.

So: no hand-drawn containers, no new widths, no new spacing scale, no second way to draw a row. If
the screen genuinely does not fit — a table, a canvas, an editor beside a live preview — that is a
deviation worth stating out loud and worth a comment saying why.

## The Shape

Four components make the frame. They compose in this order and nest no other way.

```
PageShell        the page: header (title, description, action, backButton) then children
  PageSection    a titled group of unrelated decisions, with a deliberately large gap above it
    PageRows     the grouped card: rounded-lg border bg-card
      Item       one row, size="sm", divided from its neighbours by <Separator />
    PageEmpty    what a section says when it has nothing to list
```

`PageShell` takes a `width`: `prose` (`max-w-3xl`, 768px) is the default, and every
configuration screen uses it so no screen is wider than another. Sentences inside it are held to
`max-w-prose`, so the column has room for a label beside its control without stretching the text.
`wide` (`max-w-5xl`) exists for one screen — `admin/audit.tsx`, because an audit log is a table to be
scanned and prose width would wrap every row. It is not a licence for anything else to be wide.

## The Rhythm

Spacing comes from the frame, not from the screen. These are the gaps every screen gets by using the
components above; a screen that sets its own is drifting.

| Between | Gap | Where it lives |
|---------|-----|----------------|
| Page edge (top / sides / bottom) | 48 / 16 / 64px | `PageShell` column (`pt-12` or `pt-8` under the bar, `px-4`, `pb-16`) |
| Title → description | 8px | `PageShell` header |
| Title block → first content | 32px | `PageShell`: `[&>header+*]:mt-8` |
| Title → tabs, tabs → content | 24px, then 32px | `PageShell`: `[&>header+nav]`, `[&>header+nav+*]` |
| Section → section | 48px | `PageSection` (`mt-12`) |
| Section heading → description | 4px | `PageSection` |
| Heading block → section content | 16px | `PageRows` / `PageEmpty` (`mt-4`) |
| Controls stacked inside a section | 12px | the screen, with `gap-3` |
| A row in `PageRows` | 65px with a description, never under 56px | `Item` (`px-4 py-3.5 gap-3`), `PageRows` (`min-h-14`) |
| Divider between rows | inset 16px from both edges | `PageRows`, on every horizontal `Separator` inside it |

The 32px under the title is deliberately tighter than the 48px between sections: the title belongs
to the page it introduces. Those `PageShell` selectors outrank the first child's own `mt-*`, so a
section or notice keeps its usual margin everywhere else and loses it only at the top.

A page with one section gives that section no `title`: the page title already names it, and a second
heading 32px below the first says the same thing twice. Put the description on `PageShell` instead
(`connections.index.tsx`). A count or filter that belongs to a search sits on the search's row, not
on a line of its own.

`PageEmpty` is shadcn's empty state: a bordered box where the rows would be, with an `icon` for
the kind of thing, a `title` ("No rules yet", "No matches", "Background research is off"), one
sentence of description saying how the first one arrives, and an `action` — the same Add button the
page already has — when there is one to offer. Don't repeat "Add one with X" in the description when
the action is right there. A search with no results uses `IconSearch` and "No matches".

## Procedures

### Procedure 1: Lay out a screen

1. Open with `PageShell`, giving it `title` and `description`. Leave `width` alone.
2. On a detail screen reached from a list, pass `backButton={{ label, linkProps }}` — it draws a
   chevron-left bar above the header. Do not put a Back button in `action`; `action` is for the
   page's one primary verb, on the title's baseline.
3. Group the page's decisions into `PageSection`s, each with a `title` and, where the grouping is not
   self-evident, a `description`.
4. Give each section one `PageRows` card. Rows go inside it as `Item size="sm"`, with `<Separator />`
   between them and none after the last. `PageRows` is a card with dividers, not a stack of cards —
   gaps between rows are the wrong shape.
5. Read `admin/plugins/index.tsx` for the whole pattern end to end, and
   `admin/plugins/$key.tsx` or `admin/components/$name.tsx` for a screen with several sections and
   mixed row kinds.

### Procedure 2: Compose a row

1. `ItemMedia variant="icon"` holds a leading icon from `@tabler/icons-react`, drawn as a 16px glyph
   on a 32px muted tile. It is what makes a card of rows scannable; a row without one reads as a
   paragraph. Pass the bare icon — the variant sizes and colours it — and use plain `ItemMedia` only
   for something that is its own picture, such as a Bot's avatar.
2. `ItemContent` holds `ItemTitle` and, where the row needs a second line, `ItemDescription`.
3. `ItemActions` holds the control, or the value when the row is read-only.
4. `ItemHeader` and `ItemFooter` are `basis-full`, so they wrap onto a line of their own inside the
   row. That is where a **set** goes — chips, toggles, anything that would otherwise fight the label
   for horizontal space. A set does not belong in `ItemActions`.
5. `ItemDescription` is `line-clamp-2`. Where the text is the point rather than a hint, pass
   `className="line-clamp-none"`.
6. To make the whole row navigate or open something, pass `render`:
   `render={<button type="button" onClick={…} />}` or `render={<Link to=… />}`. A real element, so
   the keyboard reaches it and a link can be opened in a new tab.

**The one mistake this makes easy:** the element passed to `render` must have **no children**.
`useRender` merges props, and children given there replace the row's own — the media, the content
and the actions all vanish and the row draws empty. The button takes its accessible name from the
title and description inside it.

### Procedure 3: Choose what a row does

Every row is one of three kinds. Picking the wrong one is the most common way one of these screens
starts to feel wrong.

1. **Binary, immediate** — a `Switch` in `ItemActions`. It takes effect when switched; there is no
   save. `ItemDescription` states the consequence in the present tense ("Bots may answer with it." /
   "No Bot may use it.").
2. **Anything larger** — a free-text field, a set of grants, more than one input — is a summary in
   `ItemDescription` plus `<IconChevronRight className="size-4 text-muted-foreground" />` in
   `ItemActions`, and the row opens a dialog. Editing more than one value in place turns a settings
   screen back into a form.
3. **Read-only** — the value in `ItemActions`, no chevron, nothing to click. A chevron on a row that
   goes nowhere is a promise the row cannot keep.

The summary on a chevron row states the current answer, not the field's name: "All 3 Bots", "2 of 3
Bots", "Nothing — it draws only what the model hands it". Compute it from the query so it updates
itself when the dialog changes something.

### Procedure 4: Sizes and variants

1. `Item size="sm"` for rows inside a card. `default` only for a row standing on its own.
2. `Button size="sm"` for a control inside a row or a dialog footer; `lg` for a page's own actions;
   `icon-sm` for a control floating over artwork.
3. `Item variant` — pick **one for the whole screen**. `muted` is a fill with no border; `outline` is
   a border with no fill; `default` is neither. Mixing two of them on one screen reads as two
   different kinds of list, and the reader looks for a distinction that is not there.
4. `bg-card` is invisible inside a dialog. `--card` and `--popover` resolve to the same colour in
   both themes, so a card-coloured row against a popover is no row at all. Use `muted`.

### Procedure 5: Add something from a list

1. Creating a thing that takes several fields — a credential, a key — is its own screen, not a dialog
   over the list. Put it at `<list>_.new.tsx` (the `_` keeps it from nesting inside the list's route),
   and make the list's `action` a `Button` rendering a `Link` to it.
2. `PageShell` with `backButton` pointing at the list, a title that is the verb ("Add credential"),
   and a description saying what happens on save.
3. The fields go in one `PageCard` inside a `<form>`, stacked in a single column, each a `Field`
   with `FieldLabel`, an optional `FieldDescription`, then the control. `PageCard`'s `footer` takes
   Cancel (`variant="outline"`, a `Link` back) and the submit button; on success, navigate to the list.
4. `admin/credentials_.new.tsx` is the reference.

### Procedure 6: Lay out a dialog

1. `DialogContent` defaults to `max-w-lg` and `max-h-[85svh]` with `p-5`. Header, body and footer go
   in as `DialogHeader` / `DialogBody className="mt-4"` / `DialogFooter className="mt-4"`.
2. `DialogBody` must stay a **direct child** of `DialogContent`. Wrapping the three sections in one
   padded div breaks the `flex-1 min-h-0` chain and the body stops scrolling.
3. `DialogBody` carries `flex-1 min-h-0` and **no overflow of its own**, despite a comment saying it
   scrolls. Any dialog tall enough to need it passes `overflow-y-auto` explicitly; without it the
   body shrinks and paints its content over the footer.
4. For artwork reaching the dialog's edges: `className="p-0 gap-0 overflow-hidden"` on
   `DialogContent`, each section carrying its own padding, and `overflow-hidden` handing the popup's
   rounding to the artwork's corners. Pass `showCloseButton={false}` and supply a close button with
   its own backing — the built-in one is a ghost button in the foreground colour and disappears over
   a pale image.

## Units

The root is the browser's 16px, so Tailwind's spacing, sizes and widths are their documented values
(`p-4` is 16px, `max-w-3xl` is 768px) and land on its 4px grid. Text is the exception: `styles.css`
sets every `--text-*` to Tailwind's default times 15/16, so `text-sm` is 13.125px and body text is
15px. That is the scale this app has always read at; do not size text in px or rem by hand to match
the docs.

Even so, never hardcode a pixel constant derived from a Tailwind token, and never compute a ratio
from one. Measure the element — `offsetWidth`, `clientWidth`, a `ResizeObserver` — and scale from what
is actually on screen. The root was once 15px, and every constant taken from the docs sat 6.25% off.

## Decision Tree

- Adding a screen → Procedure 1, then Procedure 2 for each row.
- Adding a row to an existing screen → Procedure 2, then Procedure 3 to pick its kind.
- The row toggles one thing → Procedure 3, kind 1: a `Switch`, no save.
- The row edits text, or a set of grants, or more than one value → Procedure 3, kind 2: a summary, a
  chevron, and a dialog. Then Procedure 6.
- Adding a new thing that takes several fields → Procedure 5: its own screen with a back button.
- The row only states something → Procedure 3, kind 3: a value and no chevron.
- Unsure which `Item` size, `Button` size, or `variant` → Procedure 4.
- A width, ratio or scale needs a number in pixels → the Units section. Measure, do not assume.
- Choosing a margin or gap between blocks → the Rhythm table. If the frame already gives it, set none.
- The screen genuinely does not fit this shape → say so in the response and comment the reason in the
  code. There are two accepted precedents: a table (`admin/audit.tsx`, `width="wide"`), and the
  Connections tiles (`connections.index.tsx`), a grid of separate `variant="outline"` cards, 56px
  tall and 12px apart, because apps are picked out by their mark rather than read down as a list.
- The question is which states the screen renders while loading or failing → not this skill;
  `openbot-data-access`, Procedure 3.

## Red Flags

| Signal | What it means | Do instead |
|--------|---------------|------------|
| A hand-written `rounded-lg border border-border bg-card` div wrapping rows | `PageRows` re-implemented, and it will drift from the other seven screens | Use `PageRows` |
| Rows separated by `gap-*` instead of `<Separator />` | A stack of cards rather than one card of rows | `<Separator />` between rows, none after the last |
| `width="wide"` on anything that is not a table | Prose width is the default for a reason; wide was for the audit log | Leave `width` alone |
| A `max-w-*`, `p-*` or text size invented for one screen | A fifth container width, which is what this layout exists to stop | Reach for the existing component |
| Children on an element passed to `Item`'s `render` | They replace the row's own children; the row draws empty | Pass a childless element |
| `bg-card` on a row inside a dialog | `--card` equals `--popover`; the row is invisible | `variant="muted"` |
| `Item variant="outline"` and `variant="muted"` on one screen | Reads as two kinds of list and invites a distinction that is not there | One variant per screen |
| A pixel constant matching a Tailwind rem token (672, 768, 1024) | Breaks the day a width or the root changes | Measure the element |
| An `mt-*` on a screen's first block, or a gap between blocks not in the Rhythm table | A second spacing scale, which is what made every screen feel slightly off | Let `PageShell` and `PageSection` space it |
| A one-section page whose section has a `title` | The heading repeats the page title | Drop the section title; description on `PageShell` |
| A `Switch` on a row that needs two or more values | Half the change happens in place and half in a dialog | A summary, a chevron, and a dialog |
| A chevron on a row that opens nothing | Announces a destination that does not exist | Value in `ItemActions`, no chevron |
| A set of chips or toggles crammed into `ItemActions` | It competes with the label for width and wraps badly | `ItemFooter`, which is `basis-full` |
| A back link in `PageShell`'s `action` | `action` is the page's primary verb, on the title's baseline | `backButton={{ label, linkProps }}` |

## Error Handling

- **A row renders empty — media, title and actions all missing**: children were passed on the
  element given to `Item`'s `render`. Remove them.
- **A row's content sits visibly off centre, or a card's corners are clipped by its container**: a
  pixel constant was taken from the Tailwind docs rather than measured. Measure the drawn element
  instead of the box it was given.
- **A dialog's footer has body content painted over it**: `DialogBody` is missing
  `overflow-y-auto`. It has `flex-1 min-h-0` and no overflow of its own.
- **A dialog stops scrolling after a refactor**: `DialogBody` is no longer a direct child of
  `DialogContent`. Restore it and give each section its own padding instead.
- **Artwork overflows the box it was placed in**: an inline `<svg>` with a `viewBox` and no width or
  height resolves to 100% width and a height derived from its own ratio. Give it
  `className="h-full w-full"`; `overflow-hidden` on the parent clips at the border rather than the
  padding, so it is no help here.
- **A row's summary does not change after its dialog edits something**: the summary was captured into
  state instead of computed from the query. Derive it on every render.
- **Two screens that should match do not**: one of them drew its own container. Diff the two against
  `admin/plugins/index.tsx` and delete whichever hand-drawn wrapper is not `PageRows`.
- **The layout genuinely cannot express the screen**: stop and say so rather than bending it
  silently. A deviation with a stated reason and a comment is fine; an undocumented fifth way to draw
  a card is what this skill exists to prevent.
