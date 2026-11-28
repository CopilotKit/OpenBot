# @openbot/tokens

OpenBot's color scheme: every color every app draws with, light and dark, and what each one means.
The source is [`src/scheme.ts`](src/scheme.ts).

```sh
bun run tokens:generate   # from the repository root
```

writes the scheme into every app's copy, listed in [`src/targets.ts`](src/targets.ts), and
[`tests/generated.test.ts`](tests/generated.test.ts) fails when a copy differs. Change a color in
the scheme, never in a copy. The rules for using it are in
[docs/app-guidelines.md](../docs/app-guidelines.md).
